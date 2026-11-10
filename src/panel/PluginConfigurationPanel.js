// The yey connector's Plugin Config panel, loaded by the SignalK admin UI over
// Module Federation (keyword `signalk-plugin-configurator`, container
// `signalk_yey_connector`, module `./PluginConfigurationPanel`).
//
// Plain JS and React.createElement on purpose: no JSX transform, so nothing
// pulls in react/jsx-runtime (which Module Federation does not share) and the
// host's React is the only React. Props: {configuration, save}; save(cfg)
// writes the plugin options and restarts the plugin.
//
// Everything that touches yey.boats goes through the plugin's own routes
// (lib/routes.js) under /plugins/signalk-yey-connector/, with the admin
// session cookie the admin UI already holds.

import React, { useState, useEffect, useCallback } from 'react'
import { describe } from './messages'

const h = React.createElement
const BASE = '/plugins/signalk-yey-connector'
const DEFAULT_ORIGIN = 'https://yey.boats'

async function call (method, path, body) {
  let res
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    })
  } catch (e) {
    const err = new Error(describe('network'))
    err.code = 'network'
    throw err
  }
  let data = null
  try { data = await res.json() } catch (e) { data = null }
  if (!res.ok) {
    const e = (data && data.error) || {}
    // A refusal from yey.boats arrives as a bare code (rate_limited, …): say it plainly.
    const code = e.code || ('http_' + res.status)
    const err = new Error(describe(code, e.message))
    err.code = code
    err.status = res.status
    if (e.consent) err.consent = e.consent   // consent_stale: the summary as it is now
    throw err
  }
  return data || {}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const IDENTITY_FIELDS = [
  ['name', 'Name', 'text'],
  ['mmsi', 'MMSI', 'text'],
  ['callsign', 'Call sign', 'text'],
  ['type', 'Type', 'text'],
  ['length_m', 'Length (m)', 'number'],
  ['beam_m', 'Beam (m)', 'number'],
  ['draft_m', 'Draft (m)', 'number']
]

function field (id, label, input, hint) {
  return h('div', { className: 'mb-3' },
    h('label', { htmlFor: id, className: 'form-label' }, label),
    input,
    hint ? h('div', { className: 'form-text' }, hint) : null)
}

const ITEM_TEXT = {
  data_plan: 'I approve sending the data listed above to yey.boats.',
  terms: null,   // built with the link and version
  privacy: null
}

// Statuses in which the owner is asked to (re)approve on the boat.
const NEEDS_APPROVAL = ['missing', 'expired', 'reconsent_due']

/** The boat-side consent step. Three separate boxes, all unticked. */
function ConsentForm ({ consent, deny, busy, submitLabel, onSubmit, onBack, intro }) {
  const [ticks, setTicks] = useState({ data_plan: false, terms: false, privacy: false })
  useEffect(() => { setTicks({ data_plan: false, terms: false, privacy: false }) }, [consent && consent.summary_hash])
  if (!consent) return null
  const storage = consent.storage || {}
  const terms = consent.terms || {}
  const privacy = consent.privacy || {}
  const all = ticks.data_plan && ticks.terms && ticks.privacy
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text)
  const box = (id, label) => h('div', { className: 'form-check mb-2', key: id },
    h('input', {
      id: 'yey-consent-' + id,
      className: 'form-check-input',
      type: 'checkbox',
      checked: ticks[id],
      onChange: (e) => setTicks({ ...ticks, [id]: e.target.checked })
    }),
    h('label', { className: 'form-check-label', htmlFor: 'yey-consent-' + id }, label))
  const asked = new Set((consent.on_request || []).map((f) => f.path))
  return h('form', {
    onSubmit: (ev) => { ev.preventDefault(); onSubmit({ data_plan: ticks.data_plan, terms: ticks.terms, privacy: ticks.privacy }) }
  },
  h('h6', null, 'What this server will share'),
  intro ? h('p', { className: 'small' }, intro) : null,
  h('p', { className: 'small mb-1' }, h('strong', null, 'Sent to yey.boats'), ' (only these, at the rate your plan sets):'),
  h('ul', { className: 'small' }, (consent.send || []).map((f) =>
    h('li', { key: f.path }, f.label ? f.label + ' ' : '', h('code', null, f.path),
      asked.has(f.path) ? h('span', { className: 'text-muted' }, ' (only when a question needs it)') : null))),
  h('p', { className: 'small mb-1' }, h('strong', null, 'Never sent'), ' (your Advanced list, which always wins):'),
  h('p', { className: 'small' }, deny && deny.length ? deny.map((d) => h('code', { key: d, className: 'me-2' }, d)) : 'nothing listed'),
  h('p', { className: 'small mb-1' }, h('strong', null, 'Also sent when connecting:'),
    ' the boat details you confirmed, the connector and SignalK versions, and a list of the paths this server has (names and units, no values).'),
  h('p', { className: 'small mb-1' }, h('strong', null, 'Kept on yey.boats: ')),
  h('ul', { className: 'small' },
    storage.latest ? h('li', null, 'Latest value of each field: ' + storage.latest) : null,
    storage.history_days ? h('li', null, 'History: ' + storage.history_days + ' days') : null,
    storage.who ? h('li', null, 'Who can see it: ' + storage.who) : null,
    storage.processors ? h('li', null, storage.processors) : null),
  terms.draft
    ? h('div', { className: 'alert alert-warning small py-2' },
      'The terms are still a draft (version ' + terms.version + '). Your acceptance is recorded as a draft acceptance; ' +
      'you will be asked again once the final terms are published, with time to do so.')
    : null,
  box('data_plan', ITEM_TEXT.data_plan),
  box('terms', h('span', null, 'I have read and agree to the ', link(terms.url, 'Terms'), ' (version ' + terms.version + ').')),
  box('privacy', h('span', null, 'I have read the ', link(privacy.url, 'privacy policy'), ' (' + privacy.version + ').')),
  h('div', { className: 'mt-3' },
    h('button', { type: 'submit', className: 'btn btn-primary', disabled: busy || !all }, busy ? 'Working…' : submitLabel),
    onBack ? ' ' : null,
    onBack ? h('button', { type: 'button', className: 'btn btn-link', disabled: busy, onClick: onBack }, 'Back') : null))
}

/** The auto-off line under the hours field (#22). */
function steeringAutoOffNote (auto) {
  const a = auto || {}
  const parts = ['0 means never.']
  if (a.off_at) parts.push('Switches off at ' + when(a.off_at) + '.')
  if (a.switched_off_at) parts.push('Last switched off automatically ' + when(a.switched_off_at) + '.')
  return parts.join(' ')
}

/** Why remote steering is not working although it is ticked (#39): kept off
 *  because auto-off cannot be kept across restarts, or puts refused because
 *  the boat clock looks wrong. */
function steeringWarnings (status) {
  const s = status || {}
  const auto = s.remote_steering_auto_off || {}
  const clock = s.rpc && s.rpc.clock_problem
  const lines = []
  if (auto.problem_text) lines.push('Remote steering is off: ' + auto.problem_text)
  if (clock && clock.text) lines.push(clock.text + ' (' + when(clock.at) + ')')
  if (!lines.length) return null
  return h('div', { className: 'alert alert-warning small py-2' },
    lines.map((l, i) => h('div', { key: i }, l)))
}

/** The last remote steering commands, newest first (#22). The full log is
 *  yey-steering-audit.jsonl in the plugin data folder. */
function steeringLog (rows) {
  if (!Array.isArray(rows) || !rows.length) return null
  return h('div', { className: 'mb-3' },
    h('div', { className: 'form-label small mb-1' }, 'Recent remote steering commands'),
    h('ul', { className: 'list-unstyled small text-muted mb-0' },
      rows.slice().reverse().map((r, i) => h('li', { key: i },
        when(r.t) + ' ',
        r.path ? h('code', null, r.path + (r.value !== undefined && r.value !== null ? ' = ' + r.value : '')) : null,
        ' ' + r.outcome + (r.error ? ' (' + r.error + ')' : '') +
          (r.outcome === 'auto_off' ? ': remote steering switched off' : '')))))
}

function when (iso) {
  if (!iso) return 'not yet'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? 'not yet' : d.toLocaleString()
}

export default function PluginConfigurationPanel (props) {
  const configuration = props.configuration || {}
  const save = props.save
  const advanced = configuration.advanced || {}

  const [status, setStatus] = useState(null)     // GET /status, or null while loading
  const [stopped, setStopped] = useState(false)  // the plugin is not running
  const [url, setUrl] = useState(configuration.connectionUrl || '')
  const [preview, setPreview] = useState(null)   // resolve answer, while confirming
  const [identity, setIdentity] = useState({})
  const [step, setStep] = useState('identity')   // 'identity' then 'consent'
  const [review, setReview] = useState(null)     // connected boat: the summary to (re)approve
  const [renaming, setRenaming] = useState(null) // the name being typed, or null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [deny, setDeny] = useState((advanced.deny || []).join('\n'))
  const [bufferMb, setBufferMb] = useState(advanced.bufferMegabytes || 50)
  // Remote steering: the owner's own switch, off unless saved as exactly true.
  const [steering, setSteering] = useState(configuration.remote_steering === true)
  const [autoOffHours, setAutoOffHours] = useState(configuration.remote_steering_auto_off_hours || 0)
  const [savedNote, setSavedNote] = useState('')

  const refresh = useCallback(async () => {
    try {
      setStatus(await call('GET', '/status'))
      setStopped(false)
    } catch (e) {
      if (e.code === 'plugin_stopped') setStopped(true)
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 10000)
    return () => clearInterval(t)
  }, [refresh])

  const conn = (status && status.connection) || {}
  const connected = conn.status === 'connected'
  const denyList = (advanced.deny || []).map(String).filter(Boolean)
  const consentStatus = (status && status.consent_status) || null
  const consentRecord = (status && status.consent_record) || null
  const parked = status && status.state === 'consent_required'
  const needsApproval = connected && (parked || (consentStatus && NEEDS_APPROVAL.includes(consentStatus.state)))
  const origin = conn.origin || DEFAULT_ORIGIN

  // A plugin that is switched off has no runtime to answer. Saving the
  // settings switches it on (the admin UI enables a plugin on its first save),
  // so do that, then wait for it to come up.
  async function ensureRunning () {
    if (!stopped && status) return
    try { await call('GET', '/status'); setStopped(false); return } catch (e) {
      if (e.code !== 'plugin_stopped') throw e
    }
    save({ ...configuration, connectionUrl: url.trim() })
    for (let i = 0; i < 20; i++) {
      await sleep(750)
      try { setStatus(await call('GET', '/status')); setStopped(false); return } catch (e) { /* not yet */ }
    }
    const err = new Error('The connector did not start. Switch it on above and try again.')
    err.code = 'plugin_stopped'
    throw err
  }

  // After connecting, write the link (and never a key) into the settings, so
  // the plugin list stops showing it as unconfigured. `link` is the link the
  // connector actually used (autofill junk and a bare code are cleaned up).
  function persistConnected (link) {
    const clean = String(link || url).trim()
    if (configuration.connectionUrl !== clean || configuration.key) {
      const next = { ...configuration, connectionUrl: clean }
      delete next.key
      save(next)
    }
  }

  async function onConnect (ev) {
    if (ev) ev.preventDefault()
    setError('')
    setBusy(true)
    try {
      await ensureRunning()
      // The connector cleans the input up (a link behind autofill junk, or a
      // bare code) and answers with the link it used.
      const answer = await call('POST', '/connect/resolve', { url: url.trim() })
      if (answer.url) setUrl(answer.url)
      setPreview(answer)
      const found = answer.identity || {}
      const filled = {}
      for (const [k] of IDENTITY_FIELDS) filled[k] = found[k] === null || found[k] === undefined ? '' : String(found[k])
      setIdentity(filled)
      setStep('identity')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function onConfirm (ev) {
    if (ev) ev.preventDefault()
    setError('')
    // A cloud that asks for consent: the summary comes next, and nothing is
    // paired until it is approved.
    if (preview && preview.consent && step === 'identity') { setStep('consent'); return }
    return submitConfirm(undefined)
  }

  async function submitConfirm (accepted) {
    setError('')
    setBusy(true)
    try {
      await call('POST', '/connect/confirm', accepted ? { identity, consent: { accepted } } : { identity })
      const link = preview && preview.url
      setPreview(null)
      setStep('identity')
      await refresh()
      persistConnected(link)
    } catch (e) {
      setError(e.message)
      if (e.code === 'consent_stale' && e.consent && preview) setPreview({ ...preview, consent: e.consent })
      if (e.code === 'nothing_to_confirm' || e.code === 'unknown_or_expired_code' ||
          e.code === 'invalid_or_expired_code') setPreview(null)
    } finally {
      setBusy(false)
    }
  }

  async function onReview () {
    setError('')
    setBusy(true)
    try {
      setReview(await call('GET', '/consent'))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function onApprove (accepted) {
    setError('')
    setBusy(true)
    try {
      await call('POST', '/consent', { accepted })
      setReview(null)
      await refresh()
    } catch (e) {
      setError(e.message)
      if (e.code === 'consent_stale' && e.consent) setReview({ ...review, consent: e.consent })
    } finally {
      setBusy(false)
    }
  }

  async function onRename (ev) {
    if (ev) ev.preventDefault()
    setError('')
    setBusy(true)
    try {
      await call('POST', '/display-name', { display_name: renaming })
      setRenaming(null)
      await refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function onDisconnect () {
    if (!window.confirm('Disconnect this server from yey.boats? Nothing more will be sent until you connect again.')) return
    setError('')
    setBusy(true)
    try {
      await call('POST', '/disconnect')
      await refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  function onSaveAdvanced (ev) {
    ev.preventDefault()
    const list = deny.split('\n').map((s) => s.trim()).filter(Boolean)
    const mb = Math.max(1, Number(bufferMb) || 50)
    const next = {
      ...configuration,
      remote_steering: steering === true,
      remote_steering_auto_off_hours: Math.max(0, Number(autoOffHours) || 0),
      advanced: { ...advanced, deny: list, bufferMegabytes: mb }
    }
    delete next.key
    save(next)
    setSavedNote('Saved. The connector restarts with the new settings.')
    setTimeout(() => setSavedNote(''), 4000)
  }

  const errorBox = error ? h('div', { className: 'alert alert-danger', role: 'alert' }, error) : null
  // #25: allow_custom_origin is on, or the boat talks to a site that is not yey.boats.
  const originWarning = status && status.origin_warning
    ? h('div', { className: 'alert alert-danger', role: 'alert' }, h('strong', null, status.origin_warning),
      '. Only keep this if you run that server yourself; otherwise disconnect and remove allow_custom_origin ' +
      'from the plugin settings.')
    : null

  let connection
  if (connected && review) {
    connection = h(ConsentForm, {
      consent: review.consent,
      deny: denyList,
      busy,
      submitLabel: 'Approve',
      onSubmit: onApprove,
      onBack: () => setReview(null)
    })
  } else if (connected) {
    connection = h('div', null,
      needsApproval
        ? h('div', { className: 'alert alert-warning small' },
          parked
            ? 'Nothing is being sent: yey.boats needs your approval of what this server shares. '
            : (consentStatus && consentStatus.state === 'reconsent_due'
              ? 'The terms or what is shared changed. Please review and approve again' +
                (consentStatus.reconsent_by ? ' by ' + when(consentStatus.reconsent_by) : '') + '. '
              : 'Please review and approve what this server shares with yey.boats. '),
          h('button', { type: 'button', className: 'btn btn-warning btn-sm ms-1', disabled: busy, onClick: onReview },
            'Review and approve'))
        : null,
      renaming !== null
        ? h('form', { className: 'mb-2', autoComplete: 'off', onSubmit: onRename },
          field('yey-display-name', 'Boat name',
            h('input', {
              id: 'yey-display-name', name: 'yey-boat-display-name', className: 'form-control form-control-sm',
              type: 'text', autoComplete: 'off', spellCheck: false, maxLength: 80, required: true,
              'data-lpignore': 'true', 'data-1p-ignore': 'true', 'data-form-type': 'other',
              value: renaming, onChange: (e) => setRenaming(e.target.value)
            }),
            'Shown on yey.boats and here. Renaming the boat on yey.boats changes it here too; the latest change wins.'),
          h('button', { type: 'submit', className: 'btn btn-primary btn-sm', disabled: busy || !renaming.trim() },
            busy ? 'Saving…' : 'Save'),
          ' ',
          h('button', { type: 'button', className: 'btn btn-link btn-sm', disabled: busy, onClick: () => setRenaming(null) },
            'Cancel'))
        : h('p', { className: 'mb-1' },
          h('strong', null, 'Connected to '),
          h('a', { href: origin, target: '_blank', rel: 'noopener noreferrer' }, origin.replace(/^https?:\/\//, '')),
          conn.origin_unencrypted ? ' (local, not encrypted)' : null,
          conn.display_name ? h('strong', null, ' as ' + conn.display_name) : null,
          ' ',
          h('button', {
            type: 'button', className: 'btn btn-link btn-sm p-0 align-baseline', disabled: busy,
            onClick: () => setRenaming(conn.display_name || '')
          }, conn.display_name ? 'Rename' : 'Name this boat')),
      conn.display_name_sync === 'pending'
        ? h('p', { className: 'small text-muted mb-1' }, 'Saving the new name to yey.boats…')
        : (conn.display_name_sync === 'unsupported'
          ? h('p', { className: 'small text-muted mb-1' }, 'yey.boats does not take names from the connector yet; rename the boat on yey.boats.')
          : null),
      h('ul', { className: 'list-unstyled small text-muted mb-3' },
        h('li', null, 'Last sent: ' + when(conn.last_sent_at)),
        h('li', null, 'Plan version: ' + ((status && status.plan_version) || 'none yet')),
        consentRecord
          ? h('li', null, 'Approved ' + when(consentRecord.accepted_at) + ', terms version ' + consentRecord.terms_version +
            (consentRecord.terms_draft ? ' (draft)' : ''))
          : null,
        status && status.detail ? h('li', null, 'Status: ' + status.state + ' (' + status.detail + ')') : null),
      h('button', { type: 'button', className: 'btn btn-outline-danger btn-sm', disabled: busy, onClick: onDisconnect },
        'Disconnect'))
  } else if (preview && step === 'consent') {
    connection = h(ConsentForm, {
      consent: preview.consent,
      deny: denyList,
      busy,
      intro: 'Nothing is sent until you approve.' + (preview.origin_unencrypted
        ? ' This link is local (' + preview.origin + '), not encrypted: only use it on your own boat network.'
        : ''),
      submitLabel: 'Agree and connect',
      onSubmit: submitConfirm,
      onBack: () => setStep('identity')
    })
  } else if (preview) {
    connection = h('form', { onSubmit: onConfirm },
      preview.origin_trusted === false
        ? h('div', { className: 'alert alert-danger', role: 'alert' },
          h('strong', null, 'This link is from ' + preview.origin + ', not yey.boats. '),
          'Continuing sends this boat\'s details and data to that site. Only continue if you run it yourself.')
        : null,
      preview.origin_unencrypted
        ? h('div', { className: 'alert alert-warning', role: 'alert' },
          h('strong', null, preview.origin + ' is local, not encrypted. '),
          'The boat\'s details and data travel in the clear on this network. Only continue on your own boat network.')
        : null,
      h('h6', null, 'Is this your boat?'),
      h('p', { className: 'small text-muted' },
        'Read from this SignalK server' +
        (preview.boat && preview.boat.display_name ? ', for "' + preview.boat.display_name + '" on yey.boats' : '') +
        '. Correct anything that is wrong; this becomes the boat\'s record on yey.boats.'),
      IDENTITY_FIELDS.map(([k, label, type]) => h('div', { key: k, className: 'row mb-2' },
        h('label', { htmlFor: 'yey-id-' + k, className: 'col-sm-4 col-form-label col-form-label-sm' }, label),
        h('div', { className: 'col-sm-8' },
          h('input', {
            id: 'yey-id-' + k,
            name: 'yey-boat-' + k,
            className: 'form-control form-control-sm',
            autoComplete: 'off',
            'data-lpignore': 'true',
            'data-1p-ignore': 'true',
            type,
            step: type === 'number' ? 'any' : undefined,
            value: identity[k] || '',
            onChange: (e) => setIdentity({ ...identity, [k]: e.target.value })
          })))),
      h('div', { className: 'mt-3' },
        h('button', { type: 'submit', className: 'btn btn-primary', disabled: busy },
          busy ? 'Connecting…' : (preview.consent ? 'Next' : 'Confirm')),
        ' ',
        h('button', { type: 'button', className: 'btn btn-link', disabled: busy, onClick: () => setPreview(null) }, 'Back')))
  } else {
    // autoComplete off, a field name that is not "url"/"username", type text
    // (not url) and the password-manager opt-outs: Chrome used to fill the
    // SignalK admin login into this form ("adminhttps://…"). The connector
    // also cleans such a value up (lib/connection.normalizeConnectionInput).
    connection = h('form', { onSubmit: onConnect, autoComplete: 'off' },
      h('p', { className: 'small' },
        'On ',
        h('a', { href: DEFAULT_ORIGIN + '/account/boats/new?source=plugin', target: '_blank', rel: 'noopener noreferrer' }, 'yey.boats'),
        ', open Add a boat and copy the link (or the code).'),
      field('yey-url', 'Connection link',
        h('input', {
          id: 'yey-url', name: 'yey-connection-link', className: 'form-control', type: 'text', required: true,
          inputMode: 'url', autoComplete: 'off', autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false,
          'data-lpignore': 'true', 'data-1p-ignore': 'true', 'data-form-type': 'other',
          placeholder: 'https://yey.boats/c/ABC-DEF-GHJ', value: url,
          onChange: (e) => setUrl(e.target.value)
        })),
      stopped ? h('p', { className: 'small text-muted' }, 'The connector is switched off; Connect switches it on.') : null,
      h('button', { type: 'submit', className: 'btn btn-primary', disabled: busy || !url.trim() },
        busy ? 'Connecting…' : 'Connect'))
  }

  return h('div', { className: 'yey-connector-panel', style: { maxWidth: 640 } },
    h('h5', null, 'Connection'),
    originWarning,
    errorBox,
    status === null && !stopped ? h('p', { className: 'text-muted' }, 'Loading…') : connection,
    h('details', { className: 'mt-4' },
      h('summary', null, 'Advanced'),
      h('form', { className: 'mt-2', onSubmit: onSaveAdvanced },
        field('yey-deny', 'Never send these paths',
          h('textarea', {
            id: 'yey-deny', className: 'form-control', rows: 4, value: deny,
            placeholder: 'navigation.position\nenvironment.inside',
            onChange: (e) => setDeny(e.target.value)
          }),
          'One SignalK path per line; a path also covers everything under it. This list always wins over the plan.'),
        field('yey-buffer', 'Offline buffer size (MB)',
          h('input', {
            id: 'yey-buffer', className: 'form-control', type: 'number', min: 1, step: 1,
            value: bufferMb, onChange: (e) => setBufferMb(e.target.value)
          }),
          'Kept on this server while there is no internet, sent when it is back.'),
        h('div', { className: 'form-check mb-1' },
          h('input', {
            id: 'yey-remote-steering', className: 'form-check-input', type: 'checkbox',
            checked: steering, onChange: (e) => setSteering(e.target.checked)
          }),
          h('label', { className: 'form-check-label', htmlFor: 'yey-remote-steering' },
            'Allow remote steering from yey.boats (autopilot only)')),
        h('div', { className: 'form-text mb-3' },
          'Off by default. Only the autopilot can be changed (mode, heading / wind-angle target, ' +
          'autopilot actions), by your own autopilot plugin. You must also turn it on in the ' +
          'yey.boats app with a code sent to your Telegram. The list above still applies. ' +
          'Untick and Save to switch it off.'),
        field('yey-steering-auto-off', 'Switch remote steering off after (hours)',
          h('input', {
            id: 'yey-steering-auto-off', className: 'form-control form-control-sm', type: 'number', min: 0, step: 1,
            style: { maxWidth: 120 }, value: autoOffHours, onChange: (e) => setAutoOffHours(e.target.value)
          }),
          steeringAutoOffNote(status && status.remote_steering_auto_off)),
        steeringWarnings(status),
        steeringLog(status && status.steering_log),
        h('button', { type: 'submit', className: 'btn btn-secondary btn-sm' }, 'Save'),
        savedNote ? h('span', { className: 'ms-2 small text-success' }, savedNote) : null)),
    h('p', { className: 'small text-muted mt-4 mb-0' },
      h('a', { href: origin, target: '_blank', rel: 'noopener noreferrer' }, 'yey.boats'),
      ' · Powered by ',
      h('a', { href: 'https://kdcube.tech/', target: '_blank', rel: 'noopener noreferrer' }, 'KDCube')))
}
