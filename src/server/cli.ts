import { bootstrap } from './bootstrap'
import { eq } from 'drizzle-orm'
import { users } from './db/schema'
import { createApiKey } from './lib/api-keys'
import { checkPasswordPolicy, hashPassword } from './lib/password'
import { createUser, findUserByEmail, setStationSource, sourceSchema, stationOfUser } from './stations'

const USAGE = `usage:
  cli create-user <email> [name]
  cli create-admin <email> <password> [name]
  cli create-key <email> [key-name]
  cli set-source <email> relay <url> | playlist [dir] | silence
  cli show <email>`

const [cmd, email, ...rest] = process.argv.slice(2)
if (!cmd || !email) {
  console.error(USAGE)
  process.exit(2)
}

const deps = bootstrap()
const { db, config } = deps

function station(userId: string) {
  const st = stationOfUser(db, userId)
  if (!st) throw new Error('user has no station')
  return st
}

const listen = (id: string, token: string) => `${config.publicUrl}/stream/${id}.mp3?k=${token}`

try {
  if (cmd === 'create-user') {
    const { user, station: st } = createUser(db, { email, name: rest[0] })
    console.log(`user ${user.email} created`)
    console.log(`station ${st.id}  listen: ${listen(st.id, st.listenToken)}`)
    console.log('(the app pushes the station to the engine within a few seconds)')
  } else if (cmd === 'create-admin') {
    const [password, name] = rest
    if (!password || checkPasswordPolicy(password)) throw new Error('usage: create-admin <email> <password (12+ characters)> [name]')
    const passwordHash = await hashPassword(password)
    const existing = findUserByEmail(db, email)
    if (existing) {
      db.update(users).set({ role: 'admin', passwordHash }).where(eq(users.id, existing.id)).run()
      console.log(`${email} is now an admin (password set)`)
    } else {
      const { user } = createUser(db, { email, name, role: 'admin' })
      db.update(users).set({ passwordHash }).where(eq(users.id, user.id)).run()
      console.log(`admin ${email} created`)
    }
  } else if (cmd === 'create-key') {
    const user = findUserByEmail(db, email)
    if (!user) throw new Error(`no user ${email}`)
    const { token } = await createApiKey(db, { userId: user.id, name: rest[0] ?? 'cli' })
    console.log(token)
  } else if (cmd === 'set-source') {
    const user = findUserByEmail(db, email)
    if (!user) throw new Error(`no user ${email}`)
    const [type, value] = rest
    const src = sourceSchema.parse(type === 'relay' ? { type, url: value } : type === 'playlist' ? { type, dir: value ?? '' } : { type })
    await setStationSource(db, config, deps.engine, station(user.id), src)
    console.log(`source of ${email}: ${JSON.stringify(src)}`)
  } else if (cmd === 'show') {
    const user = findUserByEmail(db, email)
    if (!user) throw new Error(`no user ${email}`)
    const st = station(user.id)
    console.log(`${user.email} (${user.role})  station ${st.id}  source ${st.source}\nlisten: ${listen(st.id, st.listenToken)}`)
  } else {
    console.error(USAGE)
    process.exit(2)
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}
