/**
 * Glohavn: adapter som viser Foundry-bussen som en koloni i Bot Crossing (apps/glo/plan-v1.md, glo 017).
 *
 * Legges i `server/harnesses/foundry.mjs` i forken coffeelyfe/glohavn, pluss én linje i `server/harnesses/index.mjs`.
 * Adapteren leser bussen, og skriver bare når Andreas trykker «Avslutt» eller «Vent» på en bot.
 *
 * Kartet: hver app er en tomt (project). Hvert åpent rom (ikke arkivert) er én bot, med siste forespørsel som tilstand:
 *   status tatt        → running   (boten hamrer på bygningen; «Vent» setter den til stopp)
 *   åpent gjøremål, eller siste melding «trenger Andreas» → unread (boten stopper med «?»)
 *   status feilet siste 3 døgn → hasError
 *   kjøring med utfall «merget» på samme oppgave siste 3 døgn → prState: 'merged' (konfetti)
 *   antall fremdriftsrader → sizeBytes (hvor ferdig bygningen ser ut)
 * Oppgaverom («foundry/029») hører til appen foran skråstreken, Glo-rom («glo/borris») til produktet etter den, og
 * Glo-rommet selv («glo») til tomta glo. «Avslutt» på en bot er avsluttRom fra Foundry-skriptene (rom.arkivert);
 * Glo-rom avsluttes aldri.
 *
 * Miljø: FOUNDRY_ROT (stien til backlog-klonen, for apps/foundry/bus.yml og apper.yml) og FOUNDRY_BUS_TOKEN
 * eller FOUNDRY_BUS_TOKEN_FIL (som bus.mjs). Åpne en bot: glo://rom/<nøkkel> i Glo-appen.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DAG = 86400e3
const ID = 'foundry'

export function lagAdapter({ env = process.env, fetchFn = globalThis.fetch, naa = () => Date.now(), avslutt } = {}) {
  const rot = env.FOUNDRY_ROT || ''

  function lesYamlEnkel(tekst) {
    // bus.yml og apper.yml er små, flate YAML-filer: «nøkkel: verdi» med innrykk. Nok for det vi trenger.
    const ut = {}; const stabel = [{ dyp: -1, obj: ut }]
    for (const rad of tekst.split('\n')) {
      if (!rad.trim() || rad.trim().startsWith('#')) continue
      const dyp = rad.match(/^ */)[0].length; const m = rad.trim().match(/^([^:#]+):\s*(.*)$/); if (!m) continue
      while (stabel.length && stabel[stabel.length - 1].dyp >= dyp) stabel.pop()
      const mor = stabel[stabel.length - 1].obj; const verdi = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '')
      if (verdi === '') { mor[m[1]] = {}; stabel.push({ dyp, obj: mor[m[1]] }) } else mor[m[1]] = verdi
    }
    return ut
  }
  function bus() {
    const y = lesYamlEnkel(fs.readFileSync(path.join(rot, 'apps', 'foundry', 'bus.yml'), 'utf8'))
    const token = env.FOUNDRY_BUS_TOKEN || (env.FOUNDRY_BUS_TOKEN_FIL && fs.existsSync(env.FOUNDRY_BUS_TOKEN_FIL) ? fs.readFileSync(env.FOUNDRY_BUS_TOKEN_FIL, 'utf8').trim() : '')
    if (!token) throw new Error('FOUNDRY_BUS_TOKEN mangler')
    return { url: String(y.supabase.url).replace(/\/$/, ''), apikey: y.supabase.publishable_key, token }
  }
  function apper() {
    try { const y = lesYamlEnkel(fs.readFileSync(path.join(rot, 'apps', 'foundry', 'apper.yml'), 'utf8')); return y.apper || {} } catch { return {} }
  }
  async function hent(b, tabell, sporring) {
    const r = await fetchFn(`${b.url}/rest/v1/${tabell}?${sporring}`, { headers: { apikey: b.apikey, Authorization: `Bearer ${b.token}`, Accept: 'application/json' } })
    if (!r.ok) throw new Error(`${tabell}: ${r.status}`)
    return r.json()
  }
  async function oppdater(b, tabell, sporring, felt) {
    const r = await fetchFn(`${b.url}/rest/v1/${tabell}?${sporring}`, { method: 'PATCH', body: JSON.stringify(felt), headers: { apikey: b.apikey, Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' } })
    if (!r.ok) throw new Error(`${tabell}: ${r.status}`)
    return r.json()
  }

  async function detect() {
    try { if (!rot || !fs.existsSync(path.join(rot, 'apps', 'foundry', 'bus.yml'))) return false; bus(); return true } catch { return false }
  }

  async function scanThreads() {
    const b = bus(); const t0 = naa(); const siden = new Date(t0 - 14 * DAG).toISOString(); const tre = t0 - 3 * DAG
    const [rom, fsp, frem, gjor, kjor, meld] = await Promise.all([
      hent(b, 'rom', 'select=id,type,nokkel,tittel,opprettet,arkivert&arkivert=is.false'),
      hent(b, 'foresporsler', `select=id,rom_id,rolle,status,tatt_av,tatt_tid,ferdig_tid,feil,opprettet&opprettet=gte.${siden}&order=opprettet.desc&limit=2000`),
      hent(b, 'fremdrift', `select=foresporsel_id,tid,type,tekst&tid=gte.${siden}&order=tid.desc&limit=4000`),
      hent(b, 'gjoremal', 'select=rom_id,app,oppgave,tekst,laget&gjort=is.null'),
      hent(b, 'kjoringer', `select=app,oppgave,utfall,tid,lenke&tid=gte.${siden}&order=tid.desc&limit=400`),
      hent(b, 'meldinger', `select=rom_id,tid,fra,tekst,trenger_andreas&tid=gte.${siden}&order=tid.desc&limit=800`),
    ])
    const romAv = Object.fromEntries(rom.map(r => [r.id, r]))
    const appAv = apper()
    const appFor = (r) => r.type === 'app' ? r.nokkel : r.type === 'oppgave' ? r.nokkel.split('/')[0] : r.type === 'glo' ? (r.nokkel.split('/')[1] || 'glo') : r.type === 'okr' ? r.nokkel.replace(/^okr\//, '') : 'foundry'
    const fremFor = {}; for (const f of frem) (fremFor[f.foresporsel_id] = fremFor[f.foresporsel_id] || []).push(f)
    const meldFor = {}; for (const m of meld) (meldFor[m.rom_id] = meldFor[m.rom_id] || []).push(m)
    const gjorFor = {}; for (const g of gjor) { if (g.rom_id) (gjorFor[g.rom_id] = gjorFor[g.rom_id] || []).push(g) }
    const mergetFor = {}; for (const k of kjor) { if (/merget/i.test(k.utfall) && new Date(k.tid).getTime() > tre) mergetFor[`${k.app}/${k.oppgave}`] = k.lenke || true }

    // Bussen svarer nyeste først, så den første forespørselen per rom er den som gjelder.
    const sisteFor = {}; for (const f of fsp) if (!sisteFor[f.rom_id]) sisteFor[f.rom_id] = f
    return rom.filter(r => !r.arkivert).map(r => {
      const f = sisteFor[r.id] || { rom_id: r.id, opprettet: r.opprettet || new Date(t0).toISOString() }
      const app = appFor(r); const def = appAv[app] || {}
      const fr = fremFor[f.id] || []; const sisteFrem = fr[0]
      const meldinger = meldFor[r.id] || []; const forste = meldinger[meldinger.length - 1]; const sisteMeld = meldinger[0]
      const sist = Math.max(...[f.opprettet, f.tatt_tid, f.ferdig_tid, sisteFrem?.tid, sisteMeld?.tid].filter(Boolean).map(x => new Date(x).getTime()))
      const venterPaaDeg = (gjorFor[r.id] || []).length > 0 || (sisteMeld && sisteMeld.trenger_andreas && sisteMeld.fra !== 'andreas')
      const oppgaveNokkel = r.type === 'oppgave' ? r.nokkel : `${app}/`
      return {
        id: `${ID}:${r.id}`,
        title: r.tittel || r.nokkel,
        preview: (forste?.tekst || '').slice(0, 160),
        project: def.navn || app,
        projectPath: def.mappe && env.FOUNDRY_APPER_ROT ? path.join(env.FOUNDRY_APPER_ROT, def.mappe) : '',
        worktree: '', cwd: '', gitBranch: '',
        model: f.tatt_av || '', effort: f.rolle,
        createdAt: new Date(f.opprettet).getTime(),
        lastActivityAt: sist,
        lastFocusedAt: 0,
        running: f.status === 'tatt',
        unread: !!venterPaaDeg,
        hasError: f.status === 'feilet' && new Date(f.ferdig_tid || f.opprettet).getTime() > tre,
        prState: mergetFor[oppgaveNokkel] ? 'merged' : '',
        archived: false,
        sizeBytes: Math.max(1, fr.length) * 2000,
        source: r.type,
        canOpen: true,
        canClose: !(r.nokkel === 'glo' || r.nokkel.startsWith('glo/')),
        canPause: f.status === 'tatt',
        subagents: fr.filter(x => x.type === 'verktoy' && f.status === 'tatt').slice(0, 2).map(x => ({ id: `${ID}:${f.id}:${x.tid}`, task: x.tekst.slice(0, 60), lastActivityAt: new Date(x.tid).getTime() })),
        ref: { rom: r.nokkel, foresporsel: f.id },
      }
    }).filter(Boolean)
  }

  async function closeThread(ref) {
    if (!ref || !ref.rom) return { ok: false, error: 'Ingen rom å avslutte' }
    if (ref.rom === 'glo' || ref.rom.startsWith('glo/')) return { ok: false, error: 'Glo-rom avsluttes ikke' }
    try {
      // Samme avslutt som Foundry-appen og MCP-en, så reglene (bygg som kjører, Glo-rom) bor ett sted.
      const fn = avslutt || (await import(pathToFileURL(path.join(rot, 'apps', 'foundry', 'skript', 'foundry.mjs')).href)).avsluttRom
      return { ok: true, melding: await fn(rot, ref.rom.split('/')) }
    } catch (e) { return { ok: false, error: e.message } }
  }
  async function pauseThread(ref) {
    if (!ref || !ref.foresporsel) return { ok: false, error: 'Ingenting i gang å stoppe' }
    try {
      const rader = await oppdater(bus(), 'foresporsler', `id=eq.${encodeURIComponent(ref.foresporsel)}&status=eq.tatt`, { status: 'stopp' })
      return rader.length ? { ok: true, melding: 'Stoppet, venter på deg' } : { ok: false, error: 'Den er ikke i gang lenger' }
    } catch (e) { return { ok: false, error: e.message } }
  }

  function openThread(ref) {
    if (!ref || !ref.rom) return { ok: false, error: 'Ingen rom å åpne' }
    return { ok: true, url: `glo://rom/${encodeURIComponent(ref.rom)}` }
  }
  function newSession(dir) {
    return { ok: true, url: `glo://ny?mappe=${encodeURIComponent(dir || '')}` }
  }

  return { id: ID, name: 'Foundry (Glo)', detect, scanThreads, openThread, newSession, closeThread, pauseThread }
}

export default lagAdapter()
