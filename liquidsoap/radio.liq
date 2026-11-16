# agent-radio engine: per-user stations created/changed at runtime through a small HTTP control API (harbor).
# The app is the source of truth and re-syncs every station after a restart (see src/server/engine).
#
#   POST /station/add          {"id": "...", "duck_db": 14, "music_db": 0, "voice_db": 0, "track_db": 0}
#   POST /station/set_source   {"id": "...", "spec": {"type": "relay", "url": "..."} | {"type": "playlist", "path": "/x.m3u"} | {"type": "silence"}}
#   POST /station/remove       {"id": "..."}
#   POST /station/set_duck     {"id": "...", "duck_db": 14}
#   POST /station/set_levels   {"id": "...", "music_db": -8, "voice_db": 4, "track_db": 0}   (any subset; applied live)
#   POST /station/set_source   ... {"type": "queue", "path": "/x.m3u", "mode": "randomize"|"normal"}   ("learn" mode: songs the app queues first, the playlist
#                              plays only when the queue is empty; the switch happens on track boundaries)
#   POST /music/push           {"id": "...", "path": "/music/x.mp3", "msg": "<id>", "title": "..."?, "amplify_db": -6.0?}   (a song or a spoken intro for the queue source)
#   POST /music/flush          {"id": "..."}   (drops what is queued, not what is playing)
#   POST /music/skip           {"id": "..."}   (ends the music track that plays now; voice clips and uploaded tracks are not touched)
#   POST /music/previous       {"id": "..."}   (plays the previous music file again, now: it goes to the front of the music queue and the current track is skipped;
#                              {"ok":true,"done":false} when there is no history)
#   GET  /music/history?id=... {"files": ["/music/a.mp3", ...]}   (the last 20 music files that started, oldest first; the last one is the current track; intros excluded)
#   GET  /music/queue?id=...   {"length": n}   (queued, not yet playing)
#   POST /voice/push           {"id": "...", "path": "/clips/x.mp3", "msg": "<message id>"?}   (spoken message: music ducked)
#   POST /track/push           {"id": "...", "path": "/clips/x.mp3", "msg": "<message id>"?}   (uploaded file: music muted, voice messages wait for it)
#   GET  /msg/states           what happened to the pushed clips that carry a message id: queued -> playing -> done (the app polls this)
#   POST /engine/restart       (exits; docker brings the engine back and the app re-pushes the stations)
#   GET  /station/list
#   GET  /station/levels       the live mix levels of every station (the acceptance test checks they are restored after an engine restart)

settings.log.level := 3
settings.init.force_start := true
settings.harbor.bind_addrs := ["0.0.0.0"]

icecast_host = environment.get(default="icecast", "ICECAST_HOST")
icecast_port = int_of_string(environment.get(default="8000", "ICECAST_PORT"))
icecast_password = environment.get(default="hackme", "ICECAST_SOURCE_PASSWORD")
control_port = int_of_string(environment.get(default="8080", "CONTROL_PORT"))
# some radios (SomaFM) reject liquidsoap's default User-Agent with an empty reply
relay_user_agent = environment.get(default="VLC/3.0.20 LibVLC/3.0.20", "RELAY_USER_AGENT")
# seconds of the fade down / up
duck_fade = float_of_string(environment.get(default="0.5", "DUCK_FADE"))
stream_bitrate = int_of_string(environment.get(default="192", "STREAM_BITRATE"))

# id -> {set_source, voice, out}
stations = ref([])

# delivery confirmation: message id -> (state, started, ended); state is queued | playing | done, times are unix seconds.
# Kept in memory only (an engine restart loses it, which is how the app learns that a queued clip is gone); the last 300 are kept.
msg_states = ref([])

def set_msg_state(id, state) =
  old = list.assoc.mem(id, msg_states()) ? list.assoc(id, msg_states()) : ("queued", 0.0, 0.0)
  let (_, started, ended) = old
  t = time()
  # the first time wins: a clip reported twice (end of the clip and the start of the next one) keeps its first times
  entry = (state, (state == "playing" and started == 0.0 ? t : started), (state == "done" and ended == 0.0 ? t : ended))
  rest = list.assoc.remove(id, msg_states())
  all = [...rest, (id, entry)]
  n = list.length(all)
  msg_states := (n > 300 ? list.tl(all) : all)
end

# one watcher per queue: the start of a clip also closes the previous one (back to back clips do not always report their end)
def clip_watcher() =
  last = ref("")
  fun (m) -> begin
    id = m["msg_id"]
    if id != "" then
      if last() != "" and last() != id then set_msg_state(last(), "done") end
      last := id
      set_msg_state(id, "playing")
    end
  end
end

def clip_ended(_, m) =
  id = m["msg_id"]
  if id != "" then set_msg_state(id, "done") end
end

def clip_uri(path, msg) =
  msg == "" ? path : "annotate:msg_id=\"#{msg}\":#{path}"
end

# annotate: values are quoted strings, so \ and " are escaped
def annot_quote(v) =
  string.replace(pattern="\"", fun (_) -> "\\\"", string.replace(pattern="\\\\", fun (_) -> "\\\\", v))
end

# a queued song / intro: msg_id for the delivery state, an optional title for the stream metadata and an optional gain
# (liq_amplify is read by the amplify that follows the queue, in dB)
def music_uri(path, msg, title, amplify_db) =
  fields = []
  fields = msg == "" ? fields : [...fields, "msg_id=\"#{msg}\""]
  fields = title == "" ? fields : [...fields, "title=\"#{annot_quote(title)}\""]
  fields = amplify_db == null ? fields : [...fields, "liq_amplify=\"#{amplify_db ?? 0.0} dB\""]
  joined = string.concat(separator=",", fields)
  list.length(fields) == 0 ? path : "annotate:#{joined}:#{path}"
end

def playlist_source(spec) =
  mksafe(playlist(mode=(if (spec.mode ?? "") == "normal" then "normal" else "randomize" end), reload_mode="watch", spec.path ?? ""))
end

# skip_reg receives the function that ends the current music track (the fallback of the "queue" / the playlist)
def music_source(spec, music_q, skip_reg) =
  t = spec.type
  if t == "relay" then
    # input.http runs on its own (network) clock: buffer() decouples it from the station clock;
    # mksafe falls back to silence whenever the relay is down, input.http reconnects by itself (poll_delay)
    mksafe(buffer(buffer=3.0, max=12.0, input.http(poll_delay=5.0, user_agent=relay_user_agent, spec.url ?? "")))
  elsif t == "playlist" then
    pl = playlist_source(spec)
    skip_reg(fun () -> pl.skip())
    pl
  elsif t == "queue" then
    # the app queues the songs (learn mode); while the queue is empty the playlist plays, switching only on track boundaries
    pl = playlist_source(spec)
    sel = fallback(track_sensitive=true, transition_length=0., [music_q, (pl : source)])
    skip_reg(fun () -> sel.skip())
    mksafe(sel)
  else
    blank()
  end
end

def add_station(id, duck_db, music_db, voice_db, track_db) =
  pending = ref(null)
  duck = ref(duck_db)
  # mix levels in dB, changed live through /station/set_levels (the amplify getters below are read on every frame)
  music_gain = ref(music_db)
  voice_gain = ref(voice_db)
  track_gain = ref(track_db)
  music = source.dynamic(init=blank(), track_sensitive=false, fun () -> begin
    v = pending()
    pending := null
    v
  end)
  voice_q = request.queue(id="voice_#{id}", interactive=false)
  voice_q.on_metadata(synchronous=false, clip_watcher())
  source.on_end(id="voice_end_#{id}", delay=0., voice_q, clip_ended)
  voice = voice_q
  # songs / intros queued by the app (learn mode), used only by a "queue" source; liq_amplify (dB) levels an intro to the voice
  music_q = request.queue(id="music_#{id}", interactive=false)
  def music_push(uri) = music_q.push.uri(uri) end
  def music_flush() = music_q.set_queue([]) end
  def music_length() = music_q.length() end
  # the front of the queue: "previous" plays before what the app has queued ahead (a learn song and its intro)
  # (the new request is appended by push.uri, which also prepares it; then the list is reordered)
  def music_push_front(uri) =
    old = music_q.queue()
    music_q.push.uri(uri)
    all = music_q.queue()
    if list.length(old) > 0 and list.length(all) == list.length(old) + 1 then
      music_q.set_queue([list.nth(all, list.length(old)), ...old])
    end
  end
  music_q.on_metadata(synchronous=false, clip_watcher())
  source.on_end(id="music_end_#{id}", delay=0., music_q, clip_ended)
  music_qa = amplify(1.0, music_q)
  # skip / previous: the source type registers how to end the current music track
  skip_fn = ref(fun () -> ())
  def skip_reg(f) = skip_fn := f end
  def music_skip() =
    f = skip_fn()
    f()
  end
  # the last 20 music files that started (oldest first, the last is the current one); intros ("learn-...-i") are not music
  history = ref([])
  music.on_track(synchronous=false, fun (m) -> begin
    f = m["filename"]
    mid = m["msg_id"]
    if f != "" and not (string.match(pattern="^learn-.*-i$", mid)) then
      all = [...history(), f]
      n = list.length(all)
      history := (n > 20 ? list.tl(all) : all)
    end
  end)
  def music_previous() =
    h = history()
    n = list.length(h)
    if n < 2 then
      false
    else
      # the previous file starts and is recorded again, so both the current and the previous one leave the list now
      prev = list.nth(h, n - 2)
      history := list.rev(list.tl(list.tl(list.rev(h))))
      music_push_front(prev)
      # the queue prepares its head in the background: skip only when it is ready, or the next track of the playlist wins
      thread.run(delay=1., music_skip)
      true
    end
  end
  # uploaded files: while one is queued/playing it replaces the whole bed (music muted, not ducked);
  # a voice message that arrives meanwhile stays in its queue (the bed is not pulled) and plays right after the file
  track_q = request.queue(id="track_#{id}", interactive=false)
  track_q.on_metadata(synchronous=false, clip_watcher())
  source.on_end(id="track_end_#{id}", delay=0., track_q, clip_ended)
  track = track_q
  # smooth_add: while `voice` has something to play, `music` drops to p of its amplitude over `duration`, then comes back
  # the music gain is applied before ducking, the voice gain on the voice only (clips are never re-encoded)
  music_out = amplify({lin_of_dB(music_gain())}, music)
  voice_out = amplify({lin_of_dB(voice_gain())}, voice)
  track_out = amplify({lin_of_dB(track_gain())}, track)
  mixed = smooth_add(duration=duck_fade, p=fun () -> lin_of_dB(0.0 - duck()), normal=music_out, special=voice_out)
  final = fallback(track_sensitive=false, transition_length=0., [track_out, mixed])
  # peak safety on the station output (+12 dB voice, loud tracks)
  limited = clip(limit(attack=2., release=150., threshold=-3.0, final))
  # lag marker: the title carries the wall-clock minute of the broadcast ("<track> [14:32]", container time zone = TZ). A player that plays a
  # backlog (VLC after a pause, a buffering proxy) shows an old time, so the listener can see how far behind it is (and press Stop, then Play).
  base_title = ref("")
  limited.on_metadata(synchronous=false, fun (m) -> begin
    t = m["title"]
    if not string.match(pattern="\\s\\[\\d\\d:\\d\\d\\]$", t) then base_title := t end
  end)
  def stamp() =
    b = base_title()
    hhmm = time.string("%H:%M")
    limited.insert_metadata(new_track=false, [("title", (b == "" ? "agent-radio" : b) ^ " [#{hhmm}]")])
    30.
  end
  thread.run.recurrent(delay=2., stamp)
  out = output.icecast(
    %mp3(bitrate=stream_bitrate, samplerate=44100, stereo=true),
    host=icecast_host, port=icecast_port, password=icecast_password,
    mount="/#{id}", name="agent-radio #{id}", mksafe(limited))
  def set_source(spec) =
    pending := music.prepare(music_source(spec, music_qa, skip_reg))
  end
  def set_levels(m, v, t) =
    music_gain := m ?? music_gain()
    voice_gain := v ?? voice_gain()
    track_gain := t ?? track_gain()
  end
  def levels() =
    {music_db=music_gain(), voice_db=voice_gain(), track_db=track_gain()}
  end
  {set_source=set_source, voice=voice_q, music_push=music_push, music_flush=music_flush, music_length=music_length, music_skip=music_skip, music_previous=music_previous, history=history, track=track_q, duck=duck, set_levels=set_levels, levels=levels, out=out}
end

def reply(resp, status, data) =
  resp.status_code(status)
  resp.json(data)
end

def parse_body(req) =
  let json.parse (x : {id : string, spec : {type : string, url : string?, path : string?, mode : string?}?, path : string?, duck_db : float?, music_db : float?, voice_db : float?, track_db : float?, msg : string?, title : string?, amplify_db : float?}) = req.body()
  x
end

def handler(f) =
  fun (req, resp) -> begin
    try
      f(parse_body(req), resp)
    catch err do
      reply(resp, 400, {ok=false, error=error.message(err)})
    end
  end
end

harbor.http.register(port=control_port, method="POST", "/station/add", handler(fun (x, resp) -> begin
  if list.assoc.mem(x.id, stations()) then
    reply(resp, 200, {ok=true, existed=true})
  else
    stations := [...stations(), (x.id, add_station(x.id, x.duck_db ?? 14.0, x.music_db ?? 0.0, x.voice_db ?? 0.0, x.track_db ?? 0.0))]
    reply(resp, 200, {ok=true, existed=false})
  end
end))

harbor.http.register(port=control_port, method="POST", "/station/set_source", handler(fun (x, resp) -> begin
  if list.assoc.mem(x.id, stations()) then
    s = list.assoc(x.id, stations())
    s.set_source(x.spec ?? {type="silence", url=null, path=null, mode=null})
    reply(resp, 200, {ok=true})
  else
    reply(resp, 404, {ok=false, error="unknown station"})
  end
end))

harbor.http.register(port=control_port, method="POST", "/station/remove", handler(fun (x, resp) -> begin
  if list.assoc.mem(x.id, stations()) then
    s = list.assoc(x.id, stations())
    s.out.shutdown()
    stations := list.assoc.remove(x.id, stations())
    reply(resp, 200, {ok=true})
  else
    reply(resp, 200, {ok=true, existed=false})
  end
end))

harbor.http.register(port=control_port, method="POST", "/voice/push", handler(fun (x, resp) -> begin
  if list.assoc.mem(x.id, stations()) then
    s = list.assoc(x.id, stations())
    msg = x.msg ?? ""
    if msg != "" then set_msg_state(msg, "queued") end
    s.voice.push.uri(clip_uri(x.path ?? "", msg))
    reply(resp, 200, {ok=true})
  else
    reply(resp, 404, {ok=false, error="unknown station"})
  end
end))

harbor.http.register(port=control_port, method="POST", "/music/push", handler(fun (x, resp) -> begin
  if list.assoc.mem(x.id, stations()) then
    s = list.assoc(x.id, stations())
    msg = x.msg ?? ""
    if msg != "" then set_msg_state(msg, "queued") end
    s.music_push(music_uri(x.path ?? "", msg, x.title ?? "", x.amplify_db))
    reply(resp, 200, {ok=true})
  else
    reply(resp, 404, {ok=false, error="unknown station"})
  end
end))

harbor.http.register(port=control_port, method="POST", "/music/flush", handler(fun (x, resp) -> begin
  if list.assoc.mem(x.id, stations()) then
    s = list.assoc(x.id, stations())
    s.music_flush()
    reply(resp, 200, {ok=true})
  else
    reply(resp, 404, {ok=false, error="unknown station"})
  end
end))

harbor.http.register(port=control_port, method="POST", "/music/skip", handler(fun (x, resp) -> begin
  if list.assoc.mem(x.id, stations()) then
    s = list.assoc(x.id, stations())
    s.music_skip()
    reply(resp, 200, {ok=true})
  else
    reply(resp, 404, {ok=false, error="unknown station"})
  end
end))

harbor.http.register(port=control_port, method="POST", "/music/previous", handler(fun (x, resp) -> begin
  if list.assoc.mem(x.id, stations()) then
    s = list.assoc(x.id, stations())
    reply(resp, 200, {ok=true, error="", done=s.music_previous()})
  else
    reply(resp, 404, {ok=false, error="unknown station", done=false})
  end
end))

harbor.http.register(port=control_port, method="GET", "/music/history", fun (req, resp) -> begin
  id = req.query["id"]
  if list.assoc.mem(id, stations()) then
    s = list.assoc(id, stations())
    reply(resp, 200, {ok=true, error="", files=s.history()})
  else
    reply(resp, 404, {ok=false, error="unknown station", files=[]})
  end
end)

harbor.http.register(port=control_port, method="GET", "/music/queue", fun (req, resp) -> begin
  id = req.query["id"]
  if list.assoc.mem(id, stations()) then
    s = list.assoc(id, stations())
    reply(resp, 200, {ok=true, error="", length=s.music_length()})
  else
    reply(resp, 404, {ok=false, error="unknown station", length=0})
  end
end)

harbor.http.register(port=control_port, method="POST", "/station/set_duck", handler(fun (x, resp) -> begin
  if list.assoc.mem(x.id, stations()) then
    s = list.assoc(x.id, stations())
    s.duck.set(x.duck_db ?? 14.0)
    reply(resp, 200, {ok=true})
  else
    reply(resp, 404, {ok=false, error="unknown station"})
  end
end))

harbor.http.register(port=control_port, method="POST", "/station/set_levels", handler(fun (x, resp) -> begin
  if list.assoc.mem(x.id, stations()) then
    s = list.assoc(x.id, stations())
    s.set_levels(x.music_db, x.voice_db, x.track_db)
    reply(resp, 200, {ok=true})
  else
    reply(resp, 404, {ok=false, error="unknown station"})
  end
end))

harbor.http.register(port=control_port, method="POST", "/track/push", handler(fun (x, resp) -> begin
  if list.assoc.mem(x.id, stations()) then
    s = list.assoc(x.id, stations())
    msg = x.msg ?? ""
    if msg != "" then set_msg_state(msg, "queued") end
    s.track.push.uri(clip_uri(x.path ?? "", msg))
    reply(resp, 200, {ok=true})
  else
    reply(resp, 404, {ok=false, error="unknown station"})
  end
end))

harbor.http.register(port=control_port, method="POST", "/engine/restart", fun (_, resp) -> begin
  reply(resp, 200, {ok=true})
  thread.run(delay=1.0, fun () -> shutdown())
end)

harbor.http.register(port=control_port, method="GET", "/station/list", fun (_, resp) -> begin
  reply(resp, 200, {stations=list.map(fun (p) -> fst(p), stations())})
end)

harbor.http.register(port=control_port, method="GET", "/station/levels", fun (_, resp) -> begin
  reply(resp, 200, {stations=list.map(fun (p) -> begin
    let (id, s) = p
    l = s.levels()
    {id=id, music_db=l.music_db, voice_db=l.voice_db, track_db=l.track_db}
  end, stations())})
end)

harbor.http.register(port=control_port, method="GET", "/msg/states", fun (_, resp) -> begin
  reply(resp, 200, {states=list.map(fun (p) -> begin
    let (id, (state, started, ended)) = p
    {id=id, state=state, started=started, ended=ended}
  end, msg_states())})
end)

log.important("agent-radio engine ready, control on :#{control_port}")
