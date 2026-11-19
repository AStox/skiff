'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const ROOT = path.resolve(__dirname, '..')
const STATE = '/var/lib/skiff-security-updater'
const THREAD = 'thr_6vbi4wijhe'
const RELEASES = 'https://api.github.com/repos/electron/electron/releases?per_page=100'
const METADATA = 'https://releases.electronjs.org/releases.json'
const semver = (s) => /^\d+\.\d+\.\d+$/.test(s) ? s.split('.').map(Number) : null
function compare(a, b) { const x = semver(a), y = semver(b); if (!x || !y) return NaN; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0 }
function selectCandidate(releases, installed) {
  if (!Array.isArray(releases)) throw Error('Invalid Electron releases response')
  const current = semver(installed)
  if (!current) throw Error(`Invalid installed Electron version: ${installed}`)
  const stable = releases.filter((r) => !r.draft && !r.prerelease && typeof r.tag_name === 'string' && /^v\d+\.\d+\.\d+$/.test(r.tag_name)).map((r) => ({ release: r, version: r.tag_name.slice(1) })).filter((x) => x.version.split('.')[0] === String(current[0]) && compare(x.version, installed) > 0).sort((a, b) => compare(b.version, a.version))
  return stable[0] || null
}
function fingerprint(root) {
  const files = []
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.git', 'node_modules', 'test-results', 'playwright-report', '.security-updater'].includes(ent.name)) continue
      const file = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(file)
      else if (ent.isFile()) files.push([path.relative(root, file).split(path.sep).join('/'), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])
      else throw Error(`Unsupported source entry: ${file}`)
    }
  }
  walk(root)
  return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex')
}
function notify(title, body) {
  const r = spawnSync(process.env.BB_BIN || 'bb', ['push-notifications', 'send', '--title', title, '--body', body, '--thread', THREAD], { encoding: 'utf8', timeout: 15000 })
  if (r.status !== 0) throw Error(`Notification delivery failed (${r.error?.message || r.status})`)
}
function notice(state, title, body, key) {
  if (state.lastNotice === key) return
  try {
    notify(title, body)
    state.lastNotice = key
    state.pendingNotification = null
  } catch (e) { state.pendingNotification = { title, body, key, error: e.message } }
}
async function json(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Skiff-security-updater', 'Accept': 'application/vnd.github+json' }, signal: AbortSignal.timeout(20000) })
  if (!r.ok) throw Error(`${url} returned HTTP ${r.status}`)
  return r.json()
}
function run(command, args, options = {}) {
  const r = spawnSync(command, args, { cwd: options.cwd || ROOT, env: { ...process.env, ...options.env }, encoding: 'utf8', timeout: options.timeout || 45 * 60_000, maxBuffer: 8 * 1024 * 1024 })
  if (r.error || r.status !== 0) throw Error(`${command} ${args.join(' ')} failed (${r.error?.message || r.status}): ${(r.stderr || r.stdout || '').slice(-3000)}`)
  return r.stdout
}
function readState() { try { return JSON.parse(fs.readFileSync(path.join(STATE, 'status.json'), 'utf8')) } catch { return {} } }
function saveState(s) { fs.mkdirSync(STATE, { recursive: true, mode: 0o700 }); const tmp = path.join(STATE, `status.${process.pid}.tmp`); fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, path.join(STATE, 'status.json')) }
function sourceHash() { return fingerprint(ROOT) }
function remote(command) {
  return run(process.env.BB_BIN || 'bb', ['terminal', 'run', '--machine', 'Work Macbook', '--cwd', '/Users/adamstockermans/skiff', '--timeout', '90s', '--max-output-bytes', '200000', '--', '/bin/zsh', '-lc', command], { timeout: 110000 })
}
function shellQuote(s) { return "'" + String(s).replaceAll("'", "'\\''") + "'" }
function promoteRuntime(live, candidate, backup, { isRunning, fingerprint, expected }) {
  const lock = `${live}.security-updater.lock`
  fs.mkdirSync(lock)
  let moved = false
  try {
    if (isRunning()) throw Error('Skiff is running; promotion deferred')
    if (fingerprint() !== expected) throw Error('Source changed after testing; promotion refused')
    if (!fs.statSync(candidate).isDirectory() || fs.lstatSync(live).isSymbolicLink()) throw Error('Invalid Electron runtime path')
    fs.renameSync(live, backup)
    moved = true
    try {
      if (isRunning() || fingerprint() !== expected) throw Error('App launched or source changed during promotion')
      fs.renameSync(candidate, live)
    } catch (e) {
      fs.renameSync(backup, live)
      moved = false
      throw e
    }
    return backup
  } catch (e) {
    if (moved && !fs.existsSync(live)) fs.renameSync(backup, live)
    throw e
  } finally { fs.rmSync(lock, { recursive: true, force: true }) }
}
function macPromotion(version, expected) {
  const code = [
    "const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto'),cp=require('node:child_process'),os=require('node:os')",
    `const VERSION=${JSON.stringify(version)},EXPECTED=${JSON.stringify(expected)},root=process.cwd(),base=p.join(os.homedir(),'Library/Caches/SkiffSecurityUpdater'),lock=p.join(base,'install.lock'),npm='/Users/adamstockermans/.nvm/versions/node/v22.22.0/bin/npm'`,
    "function walk(d){return fs.readdirSync(d,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>{if(['.git','node_modules','test-results','playwright-report','.security-updater'].includes(e.name))return [];const f=p.join(d,e.name);if(e.isDirectory())return walk(f);if(!e.isFile())throw Error('unsupported source entry');return [[p.relative(root,f).split(p.sep).join('/'),c.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]]})}",
    "function hash(){return c.createHash('sha256').update(JSON.stringify(walk(root))).digest('hex')}",
    "function running(){try{return !!cp.execFileSync('pgrep',['-f','^/Users/adamstockermans/skiff/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /Users/adamstockermans/skiff$'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()}catch(e){if(e.status===1)return false;throw e}}",
    "function swap(a,b){const swift='import Darwin\\nlet a=CommandLine.arguments[1], b=CommandLine.arguments[2]\\nlet r=a.withCString{x in b.withCString{y in renameatx_np(AT_FDCWD,x,AT_FDCWD,y,UInt32(2))}}\\nif r != 0 { perror(\"renameatx_np\"); exit(1) }';cp.execFileSync('/usr/bin/swift',['-e',swift,a,b],{stdio:'pipe',timeout:60000})}",
    "fs.mkdirSync(base,{recursive:true});fs.mkdirSync(lock);let status={version:VERSION,expected:EXPECTED,startedAt:new Date().toISOString()};try{if(hash()!==EXPECTED)throw Error('source changed since candidate tests');if(running())throw Error('Skiff running; deferred');const stage=fs.mkdtempSync(p.join(base,'stage-')),dir=p.join(stage,'node_modules/electron'),live=p.join(root,'node_modules/electron'),pkglock=p.join(root,'package-lock.json'),lockBackup=p.join(base,'package-lock-'+Date.now()+'.json'),previous=p.join(base,'electron-'+require(live+'/package.json').version+'-'+Date.now());try{cp.execFileSync(npm,['install','--prefix',stage,'--no-save',\`electron@\${VERSION}\`],{stdio:'pipe',timeout:600000});if(require(dir+'/package.json').version!==VERSION)throw Error('downloaded Electron version mismatch');const lockNow=JSON.parse(fs.readFileSync(pkglock)),lockNext=JSON.parse(fs.readFileSync(p.join(stage,'package-lock.json'))),entry=lockNext.packages['node_modules/electron'];if(!entry||JSON.stringify(entry.dependencies)!==JSON.stringify(lockNow.packages['node_modules/electron'].dependencies))throw Error('Electron lock dependencies differ; refusing unrelated lockfile changes');lockNow.packages['node_modules/electron']={...lockNow.packages['node_modules/electron'],version:entry.version,resolved:entry.resolved,integrity:entry.integrity};const lockTmp=p.join(base,'package-lock.next.json');fs.writeFileSync(lockTmp,JSON.stringify(lockNow,null,2)+'\\n',{mode:0o600});if(hash()!==EXPECTED||running())throw Error('source changed or Skiff launched during staging');if(fs.lstatSync(live).isSymbolicLink()||fs.lstatSync(pkglock).isSymbolicLink()||fs.statSync(live).dev!==fs.statSync(dir).dev)throw Error('symlink or cross-volume runtime refused');swap(live,dir);let oldMoved=false;try{fs.renameSync(dir,previous);oldMoved=true;fs.renameSync(pkglock,lockBackup);try{fs.renameSync(lockTmp,pkglock)}catch(e){fs.renameSync(lockBackup,pkglock);throw e}}catch(e){if(oldMoved)fs.renameSync(previous,dir);if(fs.existsSync(dir))swap(live,dir);if(fs.existsSync(lockBackup)&&!fs.existsSync(pkglock))fs.renameSync(lockBackup,pkglock);throw e}status={...status,status:'installed-pending-restart',previous,previousLock:lockBackup,installedAt:new Date().toISOString()};fs.writeFileSync(p.join(base,'status.json'),JSON.stringify(status,null,2)+'\\n',{mode:0o600});console.log(JSON.stringify(status))}finally{fs.rmSync(stage,{recursive:true,force:true})}}finally{fs.rmSync(lock,{recursive:true,force:true})}"
  ].join(';')
  return remote(`node -e ${shellQuote(code)}`)
}
async function main() {
  fs.mkdirSync(STATE, { recursive: true, mode: 0o700 })
  const lock = path.join(STATE, 'run.lock')
  let fd
  try { fd = fs.openSync(lock, 'wx', 0o600) } catch (e) { if (e.code === 'EEXIST') return console.log('another updater run owns lock'); throw e }
  let state = readState()
  try {
    if (state.pendingNotification) notice(state, state.pendingNotification.title, state.pendingNotification.body, state.pendingNotification.key)
    const macState = JSON.parse(remote("node -e 'const fs=require(\"node:fs\"),p=require(\"node:path\"),c=require(\"node:crypto\"),cp=require(\"node:child_process\");function w(d){return fs.readdirSync(d,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>{if([\".git\",\"node_modules\",\"test-results\",\"playwright-report\",\".security-updater\"].includes(e.name))return [];const f=p.join(d,e.name);if(e.isDirectory())return w(f);if(!e.isFile())throw Error(\"unsupported entry\");return [[p.relative(process.cwd(),f).split(p.sep).join(\"/\"),c.createHash(\"sha256\").update(fs.readFileSync(f)).digest(\"hex\")]]})}const a=w(process.cwd());const q=c.createHash(\"sha256\").update(JSON.stringify(a)).digest(\"hex\");const v=require(\"./node_modules/electron/package.json\").version;let ps=[];try{ps=cp.execFileSync(\"pgrep\",[\"-f\",\"^/Users/adamstockermans/skiff/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /Users/adamstockermans/skiff$\"],{encoding:\"utf8\",stdio:[\"ignore\",\"pipe\",\"ignore\"]}).trim().split(/\\s+/).filter(Boolean)}catch(e){if(e.status!==1)throw e}console.log(JSON.stringify({fingerprint:q,version:v,pids:ps}))'"))
    const localHash = sourceHash()
    const installed = macState.version
    const [releases, metadata] = await Promise.all([json(RELEASES), json(METADATA)])
    const candidate = selectCandidate(releases, installed)
    const chrome = (metadata.find((x) => x.version === installed) || {}).chrome || 'unknown'
    const candidateChrome = candidate && ((metadata.find((x) => x.version === candidate.version) || {}).chrome || 'unknown')
    const summary = `Electron ${installed} (Chromium ${chrome}); upstream stable ${candidate?.version || installed} (Chromium ${candidateChrome}); upstream security lag is not established by these versions.`
    state = { ...state, checkedAt: new Date().toISOString(), installed, localFingerprint: localHash, macFingerprint: macState.fingerprint, upstream: candidate?.version || installed, chromium: candidateChrome || chrome, summary, pending: candidate?.version || null, error: null }
    if (candidate) state.upstreamNotes = String(candidate.release.body || '').slice(0, 4000)
    if (!candidate) { state.status = 'current'; state.pending = null; saveState(state); console.log(JSON.stringify(state)); return }
    if (state.testedVersion === candidate.version && state.testedSource === localHash) {
      if (macState.fingerprint !== localHash) {
        state.status = 'deferred-source-mismatch'
        state.error = `Mac source ${macState.fingerprint} differs from tested source ${localHash}`
      } else if (macState.pids.length) {
        state.status = 'deferred-app-open'
        state.error = `Skiff is running (PID ${macState.pids.join(',')}); waiting for ordinary quit.`
      } else {
        const installedResult = JSON.parse(macPromotion(candidate.version, localHash))
        state.status = installedResult.status
        state.installedAt = installedResult.installedAt
        state.previousRuntime = installedResult.previous
        state.error = 'Installed; restart is pending. Skiff was not launched or restarted.'
      }
      saveState(state)
      const key = `${state.status}:${candidate.version}:${state.error}`
      if (state.status !== 'testing') {
        notice(state, state.status === 'installed-pending-restart' ? 'Skiff security update installed' : 'Skiff security update deferred', `${summary} ${state.error}`, key)
        saveState(state)
      }
      console.log(JSON.stringify(state)); return
    }
    const change = fingerprint(ROOT)
    if (change !== localHash) throw Error('Source changed after candidate selection; refusing promotion')
    state.status = 'testing'
    saveState(state)
    run('npm', ['test'], { cwd: ROOT, timeout: 10 * 60_000 })
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'skiff-electron-candidate-'))
    try {
      const app = path.join(stage, 'app')
      fs.cpSync(ROOT, app, { recursive: true, filter: (p) => !p.split(path.sep).some((x) => ['.git', 'test-results', 'playwright-report'].includes(x)) })
      fs.mkdirSync(path.join(stage, 'home'))
      fs.mkdirSync(path.join(stage, 'data'))
      const uid = Number(process.env.SKIFF_TEST_UID || 65534)
      run('chown', ['-R', `${uid}:${uid}`, stage])
      run('setpriv', [`--reuid=${uid}`, `--regid=${uid}`, '--clear-groups', 'env', `HOME=${stage}/home`, 'npm', 'install', '--prefix', path.join(stage, 'electron'), '--no-save', '--package-lock=false', `electron@${candidate.version}`], { cwd: app })
      const candidateElectron = path.join(stage, 'electron', 'node_modules', 'electron')
      if (JSON.parse(fs.readFileSync(path.join(candidateElectron, 'package.json'))).version !== candidate.version) throw Error('Candidate package version mismatch')
      const currentElectron = path.join(app, 'node_modules/electron')
      fs.rmSync(currentElectron, { recursive: true, force: true })
      fs.cpSync(candidateElectron, currentElectron, { recursive: true })
      fs.chownSync(path.join(currentElectron, 'dist/chrome-sandbox'), 0, 0)
      fs.chmodSync(path.join(currentElectron, 'dist/chrome-sandbox'), 0o4755)
      run('chown', ['-R', `${uid}:${uid}`, stage])
      run('chown', ['0:0', path.join(currentElectron, 'dist/chrome-sandbox')])
      run('chmod', ['4755', path.join(currentElectron, 'dist/chrome-sandbox')])
      run('xvfb-run', ['-a', '-s', '-screen 0 1440x1000x24', 'setpriv', `--reuid=${uid}`, `--regid=${uid}`, '--clear-groups', 'env', '-u', 'XDG_RUNTIME_DIR', '-u', 'DBUS_SESSION_BUS_ADDRESS', `HOME=${stage}/home`, `SKIFF_DATA=${stage}/data`, 'npm', 'run', 'test:visual'], { cwd: app, timeout: 40 * 60_000 })
      if (fingerprint(ROOT) !== localHash) throw Error('Source changed during candidate testing; refusing promotion')
      state.testedAt = new Date().toISOString()
      state.testedSource = localHash
      if (macState.fingerprint !== localHash) {
        state.status = 'deferred-source-mismatch'
        state.error = `Mac source ${macState.fingerprint} differs from tested source ${localHash}`
      } else if (macState.pids.length) {
        state.status = 'deferred-app-open'
        state.error = `Skiff is running (PID ${macState.pids.join(',')}); waiting for ordinary quit.`
      } else {
        const installedResult = JSON.parse(macPromotion(candidate.version, localHash))
        state.status = installedResult.status
        state.installedAt = installedResult.installedAt
        state.previousRuntime = installedResult.previous
        state.error = 'Installed; restart is pending. Skiff was not launched or restarted.'
      }
      saveState(state)
      const noticeKey = `${state.status}:${candidate.version}:${state.error}`
      if (['installed-pending-restart', 'deferred-source-mismatch', 'deferred-app-open'].includes(state.status)) {
        const title = state.status === 'installed-pending-restart' ? 'Skiff security update installed' : 'Skiff security update deferred'
        notice(state, title, `${summary} ${state.error}`, noticeKey)
        saveState(state)
      }
      console.log(JSON.stringify(state))
    } finally { fs.rmSync(stage, { recursive: true, force: true }) }
  } catch (e) {
    state = { ...state, checkedAt: new Date().toISOString(), status: 'failed', error: String(e.message).slice(0, 3000) }
    saveState(state)
    notice(state, 'Skiff security updater failed', `Check failed; installed runtime unchanged. ${state.error}`, `failed:${state.error}`)
    saveState(state)
    console.error(JSON.stringify(state))
    process.exitCode = 1
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(lock, { force: true }) }
}
if (require.main === module) {
  if (process.argv[2] === 'status') { console.log(JSON.stringify(readState(), null, 2)); process.exit(0) }
  main()
}
module.exports = { selectCandidate, compare, fingerprint, promoteRuntime }
