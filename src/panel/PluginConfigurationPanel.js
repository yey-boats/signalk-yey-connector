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
  return h('form', {
    onSubmit: (ev) => { ev.preventDefault(); onSubmit({ data_plan: ticks.data_plan, terms: ticks.terms, privacy: ticks.privacy }) }
  },
  h('h6', null, 'What this server will share'),
  intro ? h('p', { className: 'small' }, intro) : null,
  h('p', { className: 'small mb-1' }, h('strong', null, 'Sent to yey.boats'), ' (only these, at the rate your plan sets):'),
  h('ul', { className: 'small' }, (consent.send || []).map((f) =>
    h('li', { key: f.path }, f.label ? f.label + ' ' : '', h('code', null, f.path)))),
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
  const [key, setKey] = useState('')
  const [preview, setPreview] = useState(null)   // resolve answer, while confirming
  const [identity, setIdentity] = useState({})
  const [step, setStep] = useState('identity')   // URL mode: 'identity' then 'consent'
  const [keyConsent, setKeyConsent] = useState(null) // key mode: the summary to approve
  const [review, setReview] = useState(null)     // connected boat: the summary to (re)approve
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [deny, setDeny] = useState((advanced.deny || []).join('\n'))
  const [bufferMb, setBufferMb] = useState(advanced.bufferMegabytes || 50)
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

  // After connecting, write the link (and never the key) into the settings, so
  // the plugin list stops showing it as unconfigured.
  function persistConnected () {
    if (configuration.connectionUrl !== url.trim() || configuration.key) {
      const next = { ...configuration, connectionUrl: url.trim() }
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
      if (key.trim()) {
        const answer = await call('POST', '/connect/key', { url: url.trim(), key: key.trim() })
        setKey('')
        if (answer.status === 'consent') {
          setKeyConsent(answer)
        } else {
          await refresh()
          persistConnected()
        }
      } else {
        const answer = await call('POST', '/connect/resolve', { url: url.trim() })
        setPreview(answer)
        const found = answer.identity || {}
        const filled = {}
        for (const [k] of IDENTITY_FIELDS) filled[k] = found[k] === null || found[k] === undefined ? '' : String(found[k])
        setIdentity(filled)
        setStep('identity')
      }
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
      setPreview(null)
      setKeyConsent(null)
      setStep('identity')
      await refresh()
      persistConnected()
    } catch (e) {
      setError(e.message)
      if (e.code === 'consent_stale' && e.consent) {
        if (preview) setPreview({ ...preview, consent: e.consent })
        if (keyConsent) setKeyConsent({ ...keyConsent, consent: e.consent })
      }
      if (e.code === 'nothing_to_confirm' || e.code === 'unknown_or_expired_code' ||
          e.code === 'invalid_or_expired_code') { setPreview(null); setKeyConsent(null) }
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
    const next = { ...configuration, advanced: { ...advanced, deny: list, bufferMegabytes: mb } }
    delete next.key
    save(next)
    setSavedNote('Saved. The connector restarts with the new settings.')
    setTimeout(() => setSavedNote(''), 4000)
  }

  const errorBox = error ? h('div', { className: 'alert alert-danger', role: 'alert' }, error) : null

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
      h('p', { className: 'mb-1' },
        h('strong', null, 'Connected to '),
        h('a', { href: origin, target: '_blank', rel: 'noopener noreferrer' }, origin.replace(/^https?:\/\//, '')),
        h('strong', null, conn.display_name ? ' as ' + conn.display_name : '')),
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
  } else if (keyConsent) {
    connection = h(ConsentForm, {
      consent: keyConsent.consent,
      deny: denyList,
      busy,
      intro: 'Connecting with a key' + (keyConsent.boat && keyConsent.boat.display_name ? ' for "' + keyConsent.boat.display_name + '"' : '') +
        '. Nothing is sent until you approve.',
      submitLabel: 'Agree and connect',
      onSubmit: submitConfirm,
      onBack: () => setKeyConsent(null)
    })
  } else if (preview && step === 'consent') {
    connection = h(ConsentForm, {
      consent: preview.consent,
      deny: denyList,
      busy,
      intro: 'Nothing is sent until you approve.',
      submitLabel: 'Agree and connect',
      onSubmit: submitConfirm,
      onBack: () => setStep('identity')
    })
  } else if (preview) {
    connection = h('form', { onSubmit: onConfirm },
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
            className: 'form-control form-control-sm',
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
    connection = h('form', { onSubmit: onConnect },
      h('p', { className: 'small' },
        'On ',
        h('a', { href: DEFAULT_ORIGIN + '/account?source=plugin', target: '_blank', rel: 'noopener noreferrer' }, 'yey.boats'),
        ', open Account → Connect a SignalK server and copy the link.'),
      field('yey-url', 'Connection URL',
        h('input', {
          id: 'yey-url', className: 'form-control', type: 'url', required: true,
          placeholder: 'https://yey.boats/c/ABC-DEF-GHJ', value: url,
          onChange: (e) => setUrl(e.target.value)
        })),
      field('yey-key', 'Key (only if yey.boats gave you one)',
        h('input', {
          id: 'yey-key', className: 'form-control', type: 'password', autoComplete: 'off',
          placeholder: 'yk1.…', value: key, onChange: (e) => setKey(e.target.value)
        })),
      stopped ? h('p', { className: 'small text-muted' }, 'The connector is switched off; Connect switches it on.') : null,
      h('button', { type: 'submit', className: 'btn btn-primary', disabled: busy || !url.trim() },
        busy ? 'Connecting…' : 'Connect'))
  }

  return h('div', { className: 'yey-connector-panel', style: { maxWidth: 640 } },
    h('h5', null, 'Connection'),
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
        h('button', { type: 'submit', className: 'btn btn-secondary btn-sm' }, 'Save'),
        savedNote ? h('span', { className: 'ms-2 small text-success' }, savedNote) : null)),
    h('p', { className: 'small text-muted mt-4 mb-0' },
      h('a', { href: origin, target: '_blank', rel: 'noopener noreferrer' }, 'yey.boats'),
      ' · Powered by ',
      h('a', { href: 'https://kdcube.tech/', target: '_blank', rel: 'noopener noreferrer' }, 'KDCube')))
}
