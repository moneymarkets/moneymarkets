/*
 * Market kit operator UI — client.
 *
 * This file has no key material, no wallet connection and no signing code, and it is
 * meant to stay that way. It collects flags, asks the local process to build a plan
 * with the CLI's own builders, and renders what comes back. The Sign button posts the
 * same flags to /api/sign, which rebuilds the plan on the server and applies the mode
 * gate; the browser never hands the server bytes to sign.
 *
 * Every screen state the design system asks for is here: empty (nothing selected),
 * loading (skeleton), error (a notice that says the fact and the fix), and disabled
 * (Sign, with the reason in its own label).
 */

'use strict';

/** The three markets this kit knows about, and how each is addressed. */
var MARKETS = {
  MON_AUSD: {
    label: 'MON / AUSD',
    address: '0x131A2e70A5b31a517A74b8c567149bc294470Da9',
    live: true,
    defaults: { 'fee-bps': '30', 'size-per-level': '5.50', band: '0.98..1.02', levels: '6' },
  },
  AUSD_USDC: {
    label: 'AUSD / USDC',
    address: '0x699AbC15308156E9a3AB89Ec7387e9CfE1c86A3b',
    live: true,
    defaults: { 'fee-bps': '5', 'size-per-level': '5.00', band: '0.998..1.002', levels: '6' },
  },
  USDT0_AUSD: {
    label: 'USDT0 / AUSD',
    live: false,
    deploy: {
      base: '0xe7cd86e13AC4309349F30B3435a9d337750fC82D',
      quote: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a',
      'preset-from': '0x065C9d28E428A0db40191a54d33d5b7c71a9C394',
      'size-precision': '1e6',
      'min-size': '1',
      'max-size': '1000000',
      'taker-fee-bps': '0',
      'maker-fee-bps': '0',
      symbol: 'USDT0_AUSD',
    },
    defaults: {
      'fee-bps': '5',
      'size-per-level': '2.50',
      band: '0.997..1.003',
      levels: '6',
      ref: '1.0',
    },
  },
};

var selected = 'MON_AUSD';
var dryRunDone = false;
var lastForm = null;
var canSign = false;

function $(id) {
  return document.getElementById(id);
}

function text(el, value) {
  el.textContent = value;
}

function show(el, visible) {
  el.hidden = !visible;
}

/* ------------------------------- toast ---------------------------------- */

var toastTimer = null;

function toast(message) {
  var el = $('toast');
  text(el, message);
  el.classList.add('show');
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(function () {
    el.classList.remove('show');
  }, 2200);
}

/* ------------------------------- fetching -------------------------------- */

async function getJson(url) {
  var res = await fetch(url);
  var body = await res.json();
  if (!res.ok) throw new Error(body && body.error ? body.error : 'request failed');
  return body;
}

async function postJson(url, payload) {
  var res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  var body = await res.json();
  if (!res.ok) throw new Error(body && body.error ? body.error : 'request failed');
  return body;
}

/* --------------------------------- state --------------------------------- */

async function loadState() {
  try {
    var state = await getJson('/api/state');
    text($('operator'), state.operator);
    text($('block'), state.block);
    text($('sign-reason'), state.signReason);

    var chips = $('state-chips');
    chips.innerHTML = '';
    chips.appendChild(chip(state.chain === 'mainnet' ? 'Mainnet' : 'Testnet', 'acc'));
    chips.appendChild(
      chip(state.runMode === 'live' ? 'Live' : 'Dry run', state.runMode === 'live' ? 'warn' : ''),
    );
    chips.appendChild(
      chip(state.keystore ? 'Keystore found' : 'No keystore', state.keystore ? '' : 'warn'),
    );

    canSign = state.canSign === true;
    updateSignButton();
  } catch (error) {
    text($('sign-reason'), 'Could not read the local process: ' + error.message);
  }
}

function chip(label, tone) {
  var el = document.createElement('span');
  el.className = tone ? 'chip ' + tone : 'chip';
  el.textContent = label;
  return el;
}

function updateSignButton() {
  var btn = $('sign-btn');
  var enabled = canSign && dryRunDone;
  btn.disabled = !enabled;
  if (!canSign) {
    text(btn, 'Sign — needs MODE=live');
  } else if (!dryRunDone) {
    text(btn, 'Sign — dry run it first');
  } else {
    text(btn, 'Seed on chain');
  }
}

/* -------------------------------- market --------------------------------- */

async function selectMarket(key, index) {
  selected = key;
  dryRunDone = false;
  updateSignButton();
  show($('ladder-card'), false);
  show($('teardown-result'), false);

  var seg = $('market-seg');
  seg.setAttribute('data-i', String(index));
  var buttons = seg.querySelectorAll('button');
  for (var i = 0; i < buttons.length; i += 1) {
    buttons[i].setAttribute('aria-pressed', buttons[i].dataset.market === key ? 'true' : 'false');
  }

  var market = MARKETS[key];
  for (var flag in market.defaults) {
    if (!Object.prototype.hasOwnProperty.call(market.defaults, flag)) continue;
    var input = $(flag);
    if (input) input.value = market.defaults[flag];
  }
  if (!market.defaults.ref) $('ref').value = '';
  updatePps();
  updateRefSource();

  text($('market-kind'), market.live ? 'Live book' : 'Not deployed');
  show($('deploy-block'), !market.live);
  show($('params-error'), false);
  show($('params'), false);
  show($('params-empty'), false);
  show($('params-loading'), true);

  if (!market.live) {
    show($('params-loading'), false);
    show($('params-empty'), true);
    text(
      $('params-empty'),
      'This market has no contract yet, so there are no parameters to read. Dry run the ' +
        'deploy below to see the ones it would be created with.',
    );
    return;
  }

  try {
    var view = await getJson('/api/market?address=' + encodeURIComponent(market.address));
    renderParams(view);
    show($('params-loading'), false);
    show($('params'), true);
  } catch (error) {
    show($('params-loading'), false);
    show($('params-error'), true);
    text($('params-error'), 'Could not read that market: ' + error.message);
  }
}

function renderParams(view) {
  var rows = [
    ['Market', view.address],
    ['Base', view.base.symbol + '  ' + view.base.decimals + ' dp'],
    ['Quote', view.quote.symbol + '  ' + view.quote.decimals + ' dp'],
    ['Price precision', view.params.pricePrecision],
    ['Tick', view.params.tickSize + '  (' + view.params.tickHuman + ')'],
    ['Min size', view.params.minSizeHuman + ' ' + view.base.symbol],
    ['Max size', view.params.maxSizeHuman + ' ' + view.base.symbol],
    [
      'Fees',
      'taker ' + view.params.takerFeeBps + ' bps, maker ' + view.params.makerFeeBps + ' bps',
    ],
    ['Best bid', view.book.bidWire === '0' ? 'none' : wire(view.book.bidWire)],
    ['Best ask', view.book.askWire === '0' ? 'none' : wire(view.book.askWire)],
    ['Vault', view.vault.address],
    ['Vault shares', view.vault.totalSupply],
    ['Your margin, quote', view.margin.quoteHuman + ' ' + view.quote.symbol],
  ];
  var dl = $('params');
  dl.innerHTML = '';
  for (var i = 0; i < rows.length; i += 1) {
    var dt = document.createElement('dt');
    dt.textContent = rows[i][0];
    var dd = document.createElement('dd');
    dd.textContent = rows[i][1];
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
}

/** 1e18 wire price to a readable one. Display only. */
function wire(value) {
  var padded = String(value).padStart(19, '0');
  var whole = padded.slice(0, padded.length - 18);
  var fraction = padded.slice(padded.length - 18).replace(/0+$/, '');
  return fraction ? whole + '.' + fraction : whole;
}

/* ------------------------------ the seed form ---------------------------- */

function updatePps() {
  var bps = Number($('fee-bps').value);
  if (!Number.isFinite(bps) || bps <= 0) {
    text($('pps-note'), 'Spacing must be a positive number of basis points.');
    return;
  }
  text($('pps-note'), 'Stored as ' + bps * 100 + ' pps');
}

function updateRefSource() {
  var market = MARKETS[selected];
  var needsRef = !market.live || $('ref').value.trim() !== '';
  show($('ref-source-field'), needsRef);
}

function seedForm() {
  var market = MARKETS[selected];
  var form = {
    'fee-bps': $('fee-bps').value.trim(),
    'size-per-level': $('size-per-level').value.trim(),
    band: $('band').value.trim(),
    levels: $('levels').value.trim(),
    side: $('side').value,
  };
  if (market.live) {
    form.market = market.address;
  } else {
    form.hypothetical = 'true';
    for (var flag in market.deploy) {
      if (Object.prototype.hasOwnProperty.call(market.deploy, flag) && flag !== 'symbol') {
        form[flag] = market.deploy[flag];
      }
    }
  }
  var ref = $('ref').value.trim();
  if (ref) form.ref = ref;
  var refSource = $('ref-source').value.trim();
  if (refSource) form['ref-source'] = refSource;
  form.simulate = 'true';
  return form;
}

async function dryRun() {
  var btn = $('dryrun-btn');
  btn.disabled = true;
  text(btn, 'Reading the chain');
  show($('ladder-card'), false);
  try {
    var form = seedForm();
    var result = await postJson('/api/seed', form);
    lastForm = form;
    dryRunDone = true;
    renderLadder(result);
    toast('Dry run built. Nothing was sent.');
  } catch (error) {
    dryRunDone = false;
    show($('ladder-card'), true);
    show($('ladder'), false);
    $('ladder-notice').className = 'notice err';
    text($('ladder-notice'), error.message);
    text($('ladder-count'), 'no ladder');
    text($('ladder-total'), '—');
    $('calls').innerHTML = '';
    text($('command'), '');
  } finally {
    btn.disabled = false;
    text(btn, 'Dry run');
    updateSignButton();
  }
}

function renderLadder(result) {
  show($('ladder-card'), true);
  show($('ladder'), true);
  text($('ladder-count'), result.levels.length + ' orders');

  $('ladder-notice').className = 'notice ok';
  text(
    $('ladder-notice'),
    'Spacing ' +
      lastForm['fee-bps'] +
      ' bps is stored as ' +
      result.totals.feePps +
      ' pps, because Kuru counts in parts per million. Anchored on ' +
      result.totals.anchorNote +
      '. Every level is a whole number of ticks, every flip gap is at least one tick and ' +
      'under 5% of its price, and the book accepted the whole ladder in simulation.',
  );

  var ladder = $('ladder');
  ladder.innerHTML = '';
  ladder.appendChild(headRow());

  var sells = result.levels.filter(function (l) {
    return l.side === 'sell';
  });
  var buys = result.levels.filter(function (l) {
    return l.side === 'buy';
  });
  sells.sort(function (a, b) {
    return Number(b.priceRaw) - Number(a.priceRaw);
  });
  buys.sort(function (a, b) {
    return Number(b.priceRaw) - Number(a.priceRaw);
  });
  var ordered = sells.concat(buys);
  for (var i = 0; i < ordered.length; i += 1) {
    ladder.appendChild(levelRow(ordered[i], i));
  }

  text(
    $('ladder-total'),
    result.totals.quote + ' quote and ' + result.totals.base + ' base, in base units',
  );

  var calls = $('calls');
  calls.innerHTML = '';
  for (var c = 0; c < result.calls.length; c += 1) {
    calls.appendChild(callBlock(result.calls[c], c + 1));
  }
  text($('command'), result.command);
}

function headRow() {
  var row = document.createElement('div');
  row.className = 'lvl head';
  row.setAttribute('role', 'row');
  var labels = ['Side', 'Price', 'Flip', 'Size'];
  for (var i = 0; i < labels.length; i += 1) {
    var cell = document.createElement('span');
    cell.textContent = labels[i];
    if (i > 0) cell.className = 'n';
    row.appendChild(cell);
  }
  return row;
}

function levelRow(level, index) {
  var row = document.createElement('div');
  row.className = 'lvl ' + (level.side === 'buy' ? 'bid' : 'ask') + ' enter';
  row.setAttribute('role', 'row');
  // Design §2.4: ladder rows enter staggered 45 ms.
  row.style.animationDelay = index * 45 + 'ms';

  var badge = document.createElement('span');
  badge.className = 'sidebadge ' + (level.side === 'buy' ? 'buy' : 'sell');
  badge.textContent = level.side === 'buy' ? 'Buy' : 'Sell';
  row.appendChild(badge);

  var values = [level.price, level.flip, level.size];
  for (var i = 0; i < values.length; i += 1) {
    var cell = document.createElement('span');
    cell.className = 'n';
    cell.textContent = values[i];
    row.appendChild(cell);
  }
  return row;
}

function callBlock(call, index) {
  var el = document.createElement('div');
  el.className = 'call';
  var label = document.createElement('div');
  label.className = 'lbl';
  label.textContent = index + '. ' + call.label;
  var meta = document.createElement('div');
  meta.className = 'muted';
  meta.textContent =
    'to ' +
    call.to +
    ' — selector ' +
    call.selector +
    ', ' +
    call.bytes +
    ' bytes, value ' +
    call.value +
    ' wei';
  el.appendChild(label);
  el.appendChild(meta);
  return el;
}

/* -------------------------------- deploy --------------------------------- */

async function dryRunDeploy() {
  var btn = $('deploy-btn');
  btn.disabled = true;
  text(btn, 'Reading the chain');
  try {
    var market = MARKETS[selected];
    var result = await postJson('/api/deploy', market.deploy);
    show($('params'), true);
    show($('params-empty'), false);
    var dl = $('params');
    dl.innerHTML = '';
    var rows = [
      ['Predicted market', result.predictedMarket],
      ['Predicted vault', result.predictedVault],
      ['Type', result.type + ' (' + result.typeName + ')'],
      ['Already deployed', result.alreadyDeployed ? 'yes' : 'no'],
      ['Selector', result.calls[0].selector],
      ['Calldata bytes', String(result.calls[0].bytes)],
    ];
    for (var i = 0; i < rows.length; i += 1) {
      var dt = document.createElement('dt');
      dt.textContent = rows[i][0];
      var dd = document.createElement('dd');
      dd.textContent = rows[i][1];
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    toast('Deploy dry run built. Nothing was sent.');
  } catch (error) {
    show($('params-error'), true);
    text($('params-error'), 'Could not build the deploy: ' + error.message);
  } finally {
    btn.disabled = false;
    text(btn, 'Dry run the deploy');
  }
}

/* ------------------------------- teardown -------------------------------- */

async function dryRunTeardown() {
  var btn = $('teardown-btn');
  var market = MARKETS[selected];
  if (!market.live) {
    show($('teardown-result'), true);
    $('teardown-result').className = 'notice';
    text($('teardown-result'), 'That market does not exist yet, so it holds no orders to cancel.');
    return;
  }
  btn.disabled = true;
  text(btn, 'Scanning');
  try {
    var result = await postJson('/api/teardown', { market: market.address, scan: '2000' });
    show($('teardown-result'), true);
    $('teardown-result').className = 'notice ok';
    text(
      $('teardown-result'),
      'Order ids ' +
        result.scanned +
        ' scanned. Found ' +
        result.flips +
        ' flip and ' +
        result.plains +
        ' plain orders, and built ' +
        result.calls.length +
        ' transaction(s). Nothing was sent.',
    );
    toast('Teardown dry run built.');
  } catch (error) {
    show($('teardown-result'), true);
    $('teardown-result').className = 'notice err';
    text($('teardown-result'), error.message);
  } finally {
    btn.disabled = false;
    text(btn, 'Dry run the teardown');
  }
}

/* --------------------------------- sign ---------------------------------- */

async function signSeed() {
  if (!canSign || !dryRunDone || !lastForm) return;
  var btn = $('sign-btn');
  btn.disabled = true;
  text(btn, 'Signing on this machine');
  try {
    var payload = Object.assign({ command: 'seed' }, lastForm);
    delete payload.simulate;
    var result = await postJson('/api/sign', payload);
    toast('Seeded. ' + result.hashes.length + ' transaction(s) mined.');
    await loadState();
  } catch (error) {
    toast(error.message);
  } finally {
    updateSignButton();
  }
}

/* --------------------------------- wiring -------------------------------- */

function init() {
  var seg = $('market-seg');
  var buttons = seg.querySelectorAll('button');
  for (var i = 0; i < buttons.length; i += 1) {
    (function (button, index) {
      button.addEventListener('click', function () {
        void selectMarket(button.dataset.market, index);
      });
    })(buttons[i], i);
  }

  $('fee-bps').addEventListener('input', updatePps);
  $('ref').addEventListener('input', updateRefSource);
  $('dryrun-btn').addEventListener('click', function () {
    void dryRun();
  });
  $('deploy-btn').addEventListener('click', function () {
    void dryRunDeploy();
  });
  $('teardown-btn').addEventListener('click', function () {
    void dryRunTeardown();
  });
  $('sign-btn').addEventListener('click', function () {
    void signSeed();
  });

  void loadState();
  void selectMarket('MON_AUSD', 0);
}

init();
