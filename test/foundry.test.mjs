import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lagAdapter } from '../server/harnesses/foundry.mjs'

const rot = fs.mkdtempSync(path.join(os.tmpdir(), 'glohavn-'))
fs.mkdirSync(path.join(rot, 'apps', 'foundry'), { recursive: true })
fs.writeFileSync(path.join(rot, 'apps', 'foundry', 'bus.yml'), 'supabase:\n  url: https://bus.test\n  publishable_key: pk\n')
fs.writeFileSync(path.join(rot, 'apps', 'foundry', 'apper.yml'), 'apper:\n  borris:\n    navn: Borris\n    mappe: crossfit-app\n  einar-ai:\n    navn: Einar\n')
const naa = Date.parse('2026-11-09T12:00:00Z')
const T = (d) => new Date(naa - d * 3600e3).toISOString()
const data = {
  rom: [
    { id: 'r1', type: 'app', nokkel: 'borris', tittel: 'Borris', arkivert: false },
    { id: 'r2', type: 'oppgave', nokkel: 'einar-ai/127', tittel: 'Einar 127', arkivert: false },
    { id: 'r3', type: 'app', nokkel: 'glor', tittel: 'Glør', arkivert: false },
    { id: 'r4', type: 'oppgave', nokkel: 'einar-ai/099', tittel: 'Avsluttet', arkivert: true },
    { id: 'r5', type: 'glo', nokkel: 'glo/borris', tittel: 'Borris i Glo', arkivert: false, opprettet: T(300) },
  ],
  foresporsler: [
    { id: 'f0', rom_id: 'r1', rolle: 'utvikler', status: 'ferdig', opprettet: T(9) },
    { id: 'f9', rom_id: 'r4', rolle: 'utvikler', status: 'tatt', opprettet: T(1) },
    { id: 'f1', rom_id: 'r1', rolle: 'utvikler', status: 'tatt', tatt_av: 'claude', tatt_tid: T(1), opprettet: T(2) },
    { id: 'f2', rom_id: 'r2', rolle: 'utvikler', status: 'ferdig', ferdig_tid: T(5), opprettet: T(8) },
    { id: 'f3', rom_id: 'r3', rolle: 'glo', status: 'feilet', feil: 'tidsavbrudd', ferdig_tid: T(100), opprettet: T(101) },
  ],
  fremdrift: [{ foresporsel_id: 'f1', tid: T(0.5), type: 'verktoy', tekst: 'skriver koden' }, { foresporsel_id: 'f1', tid: T(0.8), type: 'start', tekst: '' }, { foresporsel_id: 'f2', tid: T(5), type: 'pr', tekst: 'PR #35' }],
  gjoremal: [{ rom_id: 'r1', app: 'borris', oppgave: '', tekst: 'Legg ut migrasjonen', laget: T(0.4) }],
  kjoringer: [{ app: 'einar-ai', oppgave: '127', utfall: 'merget', tid: T(4), lenke: 'https://github.com/x/pull/35' }],
  meldinger: [{ rom_id: 'r1', tid: T(2), fra: 'andreas', tekst: 'En app som gjør at Markus og jeg logger raskere', trenger_andreas: false }],
}
data.foresporsler.sort((x, y) => y.opprettet.localeCompare(x.opprettet)) // bussen svarer nyeste først
const kall = []
const fetchFn = async (url, opt = {}) => {
  kall.push({ url, metode: opt.method || 'GET', body: opt.body })
  const tabell = url.split('/rest/v1/')[1].split('?')[0]
  if (opt.method === 'PATCH') return { ok: true, json: async () => (url.includes('id=eq.f1') ? [{ id: 'f1', status: 'stopp' }] : []) }
  return { ok: true, json: async () => data[tabell] || [] }
}
const avsluttet = []
const avslutt = async (rot, deler) => { avsluttet.push(deler); return `avsluttet ${deler.join(' ')}` }
const a = lagAdapter({ env: { FOUNDRY_ROT: rot, FOUNDRY_BUS_TOKEN: 'hemmelig', FOUNDRY_APPER_ROT: '/repoer' }, fetchFn, naa: () => naa, avslutt })

test('oppdages når bus.yml og token finnes', async () => { assert.equal(await a.detect(), true); assert.equal(await lagAdapter({ env: {} }).detect(), false) })
test('bare åpne rom blir bots, én per rom, med siste forespørsel som tilstand', async () => {
  const t = await a.scanThreads(); assert.equal(t.length, 4, 'r4 er avsluttet')
  assert.equal(t.filter(x => x.ref.rom === 'borris').length, 1, 'f0 og f1 er samme rom')
  const borris = t.find(x => x.ref.foresporsel === 'f1')
  assert.equal(borris.project, 'Borris'); assert.equal(borris.running, true); assert.equal(borris.unread, true); assert.equal(borris.projectPath, '/repoer/crossfit-app')
  assert.equal(borris.subagents.length, 1); assert.equal(borris.preview.startsWith('En app'), true)
  const einar = t.find(x => x.ref.foresporsel === 'f2'); assert.equal(einar.project, 'Einar'); assert.equal(einar.prState, 'merged'); assert.equal(einar.running, false)
  const glor = t.find(x => x.ref.foresporsel === 'f3'); assert.equal(glor.hasError, false, 'feil eldre enn tre døgn teller ikke'); assert.equal(glor.project, 'glor')
  assert.ok(t.every(x => x.id.startsWith('foundry:')))
  const glo = t.find(x => x.ref.rom === 'glo/borris'); assert.equal(glo.project, 'Borris', 'Glo-tråden står på produktets tomt'); assert.equal(glo.ref.foresporsel, undefined); assert.equal(glo.running, false)
  assert.equal(glo.canClose, false, 'Glo-rom avsluttes aldri'); assert.equal(borris.canClose, true)
  assert.equal(borris.canPause, true); assert.equal(einar.canPause, false)
})
test('avslutt går gjennom avsluttRom fra Foundry', async () => {
  assert.deepEqual(await a.closeThread({ rom: 'einar-ai/127' }), { ok: true, melding: 'avsluttet einar-ai 127' })
  assert.deepEqual(avsluttet.at(-1), ['einar-ai', '127'])
  assert.equal((await a.closeThread({ rom: 'glo/borris' })).ok, false)
})
test('vent setter en forespørsel som er tatt til stopp, og bare den', async () => {
  assert.equal((await a.pauseThread({ rom: 'borris', foresporsel: 'f1' })).ok, true)
  const p = kall.find(k => k.metode === 'PATCH'); assert.match(p.url, /foresporsler\?id=eq\.f1&status=eq\.tatt/); assert.deepEqual(JSON.parse(p.body), { status: 'stopp' })
  assert.equal((await a.pauseThread({ rom: 'einar-ai/127', foresporsel: 'f2' })).ok, false, 'ikke i gang')
  assert.equal((await a.pauseThread({ rom: 'glo/borris' })).ok, false)
})
test('åpne går til Glo', () => { assert.deepEqual(a.openThread({ rom: 'einar-ai/127' }), { ok: true, url: 'glo://rom/einar-ai%2F127' }); assert.equal(a.openThread(null).ok, false) })
