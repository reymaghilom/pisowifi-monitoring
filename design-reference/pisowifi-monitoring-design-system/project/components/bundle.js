/* @ds-bundle: {"format":4,"namespace":"PisoWiFi","components":[{"name":"StatusBadge"},{"name":"AppShell"},{"name":"LineChart"}]} */
(function () {
  var P = {};
  var ICONS = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    wifi: '<path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8.5 16a5 5 0 0 1 7 0"/><path d="M2 9a14 14 0 0 1 20 0"/><circle cx="12" cy="19" r="1" fill="currentColor"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    shield: '<path d="M12 3l8 3v6c0 4.5-3.3 8-8 9-4.7-1-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
    zap: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M5 19l1.4-1.4M17.6 6.4L19 5"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
    bell: '<path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15z"/><path d="M10 21h4"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 6.1A9.8 9.8 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.3 7.6A16 16 0 0 0 2 12s4 7 10 7c1.6 0 3-.4 4.2-1"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
    download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
    coins: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9c-.5-1-1.5-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1 0-2-.5-2.5-1.5M12 6v1.5M12 16.5V18"/>',
    thermo: '<path d="M14 14.5V5a2 2 0 0 0-4 0v9.5a4 4 0 1 0 4 0z"/>',
    ram: '<rect x="3" y="7" width="18" height="10" rx="1.5"/><path d="M7 11v2M11 11v2M15 11v2M7 17v3M12 17v3M17 17v3"/>',
    disk: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c.8-3.5 3.5-5 7-5s6.2 1.5 7 5M16 4.5a3.5 3.5 0 0 1 0 7M18 15c2 .6 3.5 2 4 5"/>',
    send: '<path d="M21 3L3 10.5l7 3 3 7z"/><path d="M10 13.5L21 3"/>',
    play: '<path d="M7 4l13 8-13 8z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
    logout: '<path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M16 8l4 4-4 4M20 12H9"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
    network: '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M12 7.5v4M12 11.5l-6 5M12 11.5l6 5"/>',
    inbox: '<path d="M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 13h5l1 3h6l1-3h5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
  };
  P.icon = function (n, s) {
    s = s || 18;
    return '<svg class="pw-ic" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[n] || '') + '</svg>';
  };

  /* status vocabulary: always a word + an icon, never colour alone */
  var STATUS = {
    reachable: ['ok', 'check', 'Reachable'],
    unreachable: ['bad', 'x', 'Unreachable'],
    recent: ['info', 'clock', 'Recently Seen'],
    stale: ['warn', 'alert', 'Stale'],
    unknown: ['mute', 'info', 'Unknown'],
    error: ['bad', 'alert', 'Monitoring Error'],
    inet: ['warn', 'globe', 'Internet Not Yet Verified'],
    soon: ['mute', 'clock', 'Coming Soon'],
    notconn: ['mute', 'link', 'Not Connected Yet'],
    demo: ['info', 'info', 'Demo data'],
    sample: ['info', 'info', 'Sample data'],
    proto: ['warn', 'info', 'Prototype only'],
    enabled: ['ok', 'check', 'Enabled'],
    paused: ['mute', 'pause', 'Paused'],
    failed: ['bad', 'x', 'Failed'],
    nodata: ['mute', 'info', 'Not enough checks']
  };
  ICONS.link = '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>';
  P.StatusBadge = P.badge = function (key, label) {
    var s = STATUS[key] || STATUS.unknown;
    return '<span class="pw-badge ' + s[0] + '">' + P.icon(s[1], 14) + (label || s[2]) + '</span>';
  };

  P.logo = function (size) {
    return '<span class="pw-logo-mark" style="' + (size ? 'width:' + size + 'px;height:' + size + 'px' : '') + '">' + P.icon('wifi', size ? size * 0.6 : 19) + '</span>';
  };

  var NAV = [
    ['dash', 'dashboard', 'Dashboard'],
    ['machines', 'server', 'My PisoWiFi'],
    ['detail', 'pulse', 'Machine Details'],
    ['remote', 'shield', 'Remote Administration'],
    ['history', 'history', 'Monitoring History'],
    ['reports', 'chart', 'Reports & Analytics'],
    ['auto', 'zap', 'Automations / Integrations'],
    ['settings', 'settings', 'Settings']
  ];
  P.nav = function (active) {
    return '<nav class="pw-nav" aria-label="Main">' + NAV.map(function (n) {
      return '<a href="#" ' + (n[0] === active ? 'aria-current="page"' : '') + '>' + P.icon(n[1], 19) + n[2] + '</a>';
    }).join('') + '</nav>';
  };
  P.sideFoot = '<div class="pw-side-foot"><strong style="color:var(--ink)">Prototype · Demo data</strong><br>No live connection to ZeroTier, WiFi5Soft or n8n.</div>';

  /* AppShell(active, title, subtitle, contentHTML, headActionsHTML) → HTML string */
  P.AppShell = P.shell = function (active, title, sub, content, actions) {
    return '<div class="pw-app"><aside class="pw-side"><div class="pw-logo">' + P.logo() + 'PisoWiFi Monitoring</div>' + P.nav(active) + P.sideFoot + '</aside>' +
      '<div style="min-width:0"><header class="pw-top"><div class="pw-grow"><h1 class="pw-h1">' + title + '</h1>' + (sub ? '<div class="pw-small pw-muted">' + sub + '</div>' : '') + '</div>' +
      '<label class="pw-search">' + P.icon('search', 18) + '<input placeholder="Search machines, events…" aria-label="Search"></label>' +
      '<button class="pw-icon-btn" aria-label="Refresh">' + P.icon('refresh') + '</button>' +
      '<button class="pw-icon-btn" data-pw-theme aria-label="Toggle light or dark theme">' + P.icon('moon') + '</button>' +
      '<div class="pw-row" style="gap:8px"><span class="pw-avatar">OP</span><div style="line-height:16px"><div class="pw-small" style="color:var(--ink)">Operator</div><div class="pw-small pw-muted">Owner</div></div>' + P.icon('chevron', 16) + '</div>' +
      '</header><main class="pw-page">' + (actions ? '<div class="pw-row pw-wrap" style="justify-content:flex-end">' + actions + '</div>' : '') + content + '</main></div></div>';
  };

  P.kpi = function (icon, tone, label, value, sub, badge) {
    return '<div class="pw-card pw-stat"><div class="pw-stat-top"><span class="pw-label">' + label + '</span><span class="pw-stat-ic ' + tone + '">' + P.icon(icon, 19) + '</span></div><div class="pw-kpi">' + value + '</div><div class="pw-small pw-muted">' + (sub || '') + '</div></div>';
  };

  /* sample data: every number here is invented for the prototype */
  P.data = {
    machines: [
      { id: 'm1', name: 'PisoWiFi 01', loc: 'Location not set (demo)', sw: 'WiFi5Soft', ver: 'v3.5.84', ip: '192.168.194.82', path: '/admin', status: 'reachable', seen: '1 min ago', ok: '1 min ago', tags: ['demo', 'primary'] },
      { id: 'm2', name: 'PisoWiFi 02', loc: 'Location not set (demo)', sw: 'WiFi5Soft', ver: 'Version unknown', ip: '192.168.194.127', path: '/admin', status: 'stale', seen: '14 min ago', ok: '3 h ago', tags: ['demo'] }
    ],
    days: ['Sep 28', 'Sep 29', 'Sep 30', 'Oct 1', 'Oct 2', 'Oct 3', 'Oct 4', 'Oct 5', 'Oct 6', 'Oct 7', 'Oct 8', 'Oct 9', 'Oct 10', 'Oct 11'],
    up1: [100, 100, 99.8, 100, 98.9, 100, 100, 99.7, 100, 100, 97.2, 100, 100, 99.9],
    up2: [99.1, 98.7, 100, 96.4, 99.5, 98.2, 99.9, 97.8, 99.2, 94.6, 99.0, 98.4, 96.9, 97.5],
    rt1: [42, 44, 41, 47, 52, 43, 41, 45, 44, 42, 61, 43, 41, 44],
    rt2: [88, 92, 85, 120, 96, 101, 90, 134, 97, 148, 93, 99, 118, 105]
  };

  /* LineChart({w,h,labels,series:[{v,cls}],min,max,ticks,unit,area}) → svg string */
  P.LineChart = P.line = function (o) {
    var w = o.w || 640, h = o.h || 240, L = 40, R = 12, T = 12, B = 26;
    var min = o.min, max = o.max, n = o.labels.length, ticks = o.ticks || 4;
    var iw = w - L - R, ih = h - T - B;
    var X = function (i) { return L + (n === 1 ? iw / 2 : i * iw / (n - 1)); };
    var Y = function (v) { return T + ih - (v - min) / (max - min) * ih; };
    var s = '<svg class="pw-chart" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + (o.alt || 'Sample chart') + '">';
    for (var t = 0; t <= ticks; t++) {
      var v = min + (max - min) * t / ticks, y = Y(v);
      s += '<line class="grid" x1="' + L + '" x2="' + (w - R) + '" y1="' + y + '" y2="' + y + '"/><text x="' + (L - 8) + '" y="' + (y + 4) + '" text-anchor="end">' + Math.round(v * 10) / 10 + (o.unit || '') + '</text>';
    }
    var step = Math.ceil(n / 7);
    o.labels.forEach(function (lb, i) { if (i % step === 0 || i === n - 1) s += '<text x="' + X(i) + '" y="' + (h - 6) + '" text-anchor="middle">' + lb + '</text>'; });
    o.series.forEach(function (se) {
      var d = se.v.map(function (v, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(Math.max(min, Math.min(max, v))).toFixed(1); }).join(' ');
      if (se.area) s += '<path class="a1" d="' + d + ' L' + X(n - 1) + ' ' + (T + ih) + ' L' + X(0) + ' ' + (T + ih) + ' Z"/>';
      s += '<path class="' + se.cls + '" d="' + d + '"/>';
    });
    return s + '</svg>';
  };

  /* status strip: array of 'ok'|'bad'|'warn'|'mute' → one segmented bar */
  P.strip = function (arr, h) {
    h = h || 28; var w = 600, g = 2, cw = (w - g * (arr.length - 1)) / arr.length;
    return '<svg class="pw-chart" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Sample status timeline">' + arr.map(function (k, i) {
      return '<rect class="s-' + k + '" x="' + (i * (cw + g)).toFixed(1) + '" y="0" width="' + cw.toFixed(1) + '" height="' + h + '" rx="3"/>';
    }).join('') + '</svg>';
  };

  /* grouped bars: groups [{label, a, b}] */
  P.bars = function (o) {
    var w = o.w || 520, h = o.h || 220, L = 34, B = 26, T = 10, ih = h - T - B, n = o.groups.length, gw = (w - L - 8) / n, bw = Math.min(22, gw / 3), max = o.max;
    var s = '<svg class="pw-chart" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + (o.alt || 'Sample bar chart') + '">';
    for (var t = 0; t <= 4; t++) { var y = T + ih - ih * t / 4; s += '<line class="grid" x1="' + L + '" x2="' + (w - 8) + '" y1="' + y + '" y2="' + y + '"/><text x="' + (L - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + Math.round(max * t / 4) + '</text>'; }
    o.groups.forEach(function (g, i) {
      var cx = L + gw * i + gw / 2, ha = g.a / max * ih, hb = g.b / max * ih;
      s += '<rect class="b1" x="' + (cx - bw - 1) + '" y="' + (T + ih - ha) + '" width="' + bw + '" height="' + ha + '" rx="4"/><rect class="b2" x="' + (cx + 1) + '" y="' + (T + ih - hb) + '" width="' + bw + '" height="' + hb + '" rx="4"/><text x="' + cx + '" y="' + (h - 6) + '" text-anchor="middle">' + g.label + '</text>';
    });
    return s + '</svg>';
  };

  P.events = [
    ['warn', 'alert', 'PisoWiFi 02', 'Stale — no successful HTTP check for 15 min', '12 min ago'],
    ['ok', 'check', 'PisoWiFi 01', 'Recovered — admin interface reachable again', '2 h ago'],
    ['bad', 'x', 'PisoWiFi 01', 'Unreachable — HTTP check timed out after 5 s', '2 h 9 min ago'],
    ['mute', 'info', 'PisoWiFi 02', 'Internet not yet verified — check not configured', 'Yesterday'],
    ['info', 'settings', 'System', 'Monitoring interval changed to 60 s (demo)', 'Yesterday']
  ];
  P.eventList = function (n) {
    return '<ul class="pw-events">' + P.events.slice(0, n || 5).map(function (e) {
      return '<li><span class="pw-ev-ic ' + e[0] + '">' + P.icon(e[1], 16) + '</span><div class="pw-grow"><div style="font-weight:600">' + e[2] + '</div><div class="pw-muted" style="font-size:13px">' + e[3] + '</div></div><span class="pw-small pw-muted" style="white-space:nowrap">' + e[4] + '</span></li>';
    }).join('') + '</ul>';
  };

  P.field = function (label, input, help, state, msg) {
    return '<div class="pw-field ' + (state || '') + '"><label>' + label + '</label>' + input + (msg ? '<div class="pw-msg-' + (state === 'ok' ? 'ok' : 'err') + '">' + P.icon(state === 'ok' ? 'check' : 'alert', 14) + msg + '</div>' : (help ? '<div class="pw-help">' + help + '</div>' : '')) + '</div>';
  };

  window.PisoWiFi = P;
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-pw-theme]');
    if (b) { var r = document.documentElement; r.setAttribute('data-theme', r.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); }
  });
})();
