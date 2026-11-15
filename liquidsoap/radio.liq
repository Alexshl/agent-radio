# agent-radio engine: per-user stations created/changed at runtime through a small HTTP control API (harbor).
# The app is the source of truth and re-syncs every station after a restart (see src/server/engine).
#
#   POST /station/add          {"id": "...", "duck_db": 14, "music_db": 0, "voice_db": 0, "track_db": 0}
#   POST /station/set_source   {"id": "...", "spec": {"type": "relay", "url": "..."} | {"type": "playlist", "path": "/x.m3u"} | {"type": "silence"}}
#   POST /station/remove       {"id": "..."}
#   POST /station/set_duck     {"id": "...", "duck_db": 14}
#   POST /station/set_levels   {"id": "...", "music_db": -8, "voice_db": 4, "track_db": 0}   (any subset; applied live)
#   POST /voice/push           {"id": "...", "path": "/clips/x.mp3"}   (spoken message: music ducked)
#   POST /track/push           {"id": "...", "path": "/clips/x.mp3"}   (uploaded file: music muted, voice messages wait for it)
#   POST /engine/restart       (exits; docker brings the engine back and the app re-pushes the stations)
#   GET  /station/list

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

def music_source(spec) =
  t = spec.type
  if t == "relay" then
    # input.http runs on its own (network) clock: buffer() decouples it from the station clock;
    # mksafe falls back to silence whenever the relay is down, input.http reconnects by itself (poll_delay)
    mksafe(buffer(buffer=3.0, max=12.0, input.http(poll_delay=5.0, user_agent=relay_user_agent, spec.url ?? "")))
  elsif t == "playlist" then
    mksafe(playlist(mode=(if spec.mode == "normal" then "normal" else "randomize" end), reload_mode="watch", spec.path ?? ""))
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
  voice = request.queue(id="voice_#{id}", interactive=false)
  # uploaded files: while one is queued/playing it replaces the whole bed (music muted, not ducked);
  # a voice message that arrives meanwhile stays in its queue (the bed is not pulled) and plays right after the file
  track = request.queue(id="track_#{id}", interactive=false)
  # smooth_add: while `voice` has something to play, `music` drops to p of its amplitude over `duration`, then comes back
  # the music gain is applied before ducking, the voice gain on the voice only (clips are never re-encoded)
  music_out = amplify({lin_of_dB(music_gain())}, music)
  voice_out = amplify({lin_of_dB(voice_gain())}, voice)
  track_out = amplify({lin_of_dB(track_gain())}, track)
  mixed = smooth_add(duration=duck_fade, p=fun () -> lin_of_dB(0.0 - duck()), normal=music_out, special=voice_out)
  final = fallback(track_sensitive=false, transition_length=0., [track_out, mixed])
  # peak safety on the station output (+12 dB voice, loud tracks)
  limited = clip(limit(attack=2., release=150., threshold=-3.0, final))
  out = output.icecast(
    %mp3(bitrate=stream_bitrate, samplerate=44100, stereo=true),
    host=icecast_host, port=icecast_port, password=icecast_password,
    mount="/#{id}", name="agent-radio #{id}", mksafe(limited))
  def set_source(spec) =
    pending := music.prepare(music_source(spec))
  end
  def set_levels(m, v, t) =
    music_gain := m ?? music_gain()
    voice_gain := v ?? voice_gain()
    track_gain := t ?? track_gain()
  end
  {set_source=set_source, voice=voice, track=track, duck=duck, set_levels=set_levels, out=out}
end

def reply(resp, status, data) =
  resp.status_code(status)
  resp.json(data)
end

def parse_body(req) =
  let json.parse (x : {id : string, spec : {type : string, url : string?, path : string?, mode : string?}?, path : string?, duck_db : float?, music_db : float?, voice_db : float?, track_db : float?}) = req.body()
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
    s.voice.push.uri(x.path ?? "")
    reply(resp, 200, {ok=true})
  else
    reply(resp, 404, {ok=false, error="unknown station"})
  end
end))

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
    s.track.push.uri(x.path ?? "")
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

log.important("agent-radio engine ready, control on :#{control_port}")
