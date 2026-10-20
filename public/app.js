/* Single authenticated application shell. Updates arrive through one SSE stream. */
(() => {
  'use strict';
  const bootstrap = window.__DASHBOARD__;
  if (!bootstrap) return;
  const main = document.getElementById('app-main');
  const messages = document.getElementById('app-messages');
  const connection = document.getElementById('connection-status');
  const labels = { queued: 'Queued', running: 'Running', succeeded: 'Succeeded', partial: 'Partial', failed: 'Failed', interrupted: 'Interrupted', skipped: 'Skipped' };
  let snapshot = bootstrap.snapshot;
  let source = null;
  let streamKey = '';
  let streamState = 'connecting';
  let expired = false;
  let routeVersion = 0;
  let currentPath = location.pathname + location.search;
  let disposeView = () => {};
  let dirty = () => false;
  let updateView = () => {};
  let receiveHistory = () => {};
  let receiveLog = () => {};
  let selectedStream = {};
  let monacoPromise;

  function element(tag, attributes = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'onclick') node.addEventListener('click', value);
      else if (key === 'checked' || key === 'disabled' || key === 'hidden') node[key] = Boolean(value);
      else if (key === 'value') node.value = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child !== undefined && child !== null) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }
  const button = (text, onClick, className = 'btn btn-ghost') => element('button', { type: 'button', class: className, text, onclick: onClick });
  const link = (text, href, className = 'btn btn-ghost') => element('a', { href, class: className, 'data-nav': '', text });
  const date = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '—';
  const runTime = (run) => run.started_at || run.queued_at;
  const pathFor = (job, section) => `/${section}/${encodeURIComponent(job.name)}`;
  const updateActive = (update) => Boolean(update.updating) || ['requested', 'waiting', 'draining', 'running', 'updating', 'restarting'].includes(update.status);
  function duration(run) {
    if (!run.started_at) return '—';
    const seconds = Math.max(0, Math.floor(((run.finished_at ? Date.parse(run.finished_at) : Date.now()) - Date.parse(run.started_at)) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
  function badge(status) {
    return element('span', { class: 'status-badge', 'data-state': status || '' }, [element('span', { class: 'status-dot', 'aria-hidden': 'true' }), labels[status] || 'Not run']);
  }
  function announce(text, category = 'success') {
    if (!text) return;
    const notice = element('div', { class: `alert app-message ${category === 'success' ? 'alert-success' : 'alert-error'}`, role: category === 'success' ? 'status' : 'alert' });
    notice.append(element('span', { text }), button('×', () => notice.remove()));
    notice.lastChild.setAttribute('aria-label', 'Dismiss message');
    messages.replaceChildren(notice);
  }
  function showConnection() {
    if (expired) return;
    const worker = snapshot.worker || {};
    const update = snapshot.update || {};
    let text = streamState === 'connected' ? 'Live updates connected.' : streamState === 'stopped' ? 'Live updates stopped. Close extra dashboard tabs, then reconnect.' : streamState === 'reconnecting' ? 'Connection lost. Reconnecting automatically…' : 'Connecting to live updates…';
    if (streamState === 'connected' && !worker.online) text += ' Execution service is offline; queued jobs will wait.';
    if (worker.draining) text += ' Finishing active jobs before maintenance.';
    if (updateActive(update)) text += ` ${update.message || 'The dashboard update is in progress.'}`;
    if (update.status === 'failed') text += ` Update failed: ${update.message || 'Check the deployment service logs.'}`;
    if (update.status === 'succeeded') text += ' Dashboard updated. Reload when ready to use the new version.';
    connection.textContent = text;
    if (streamState === 'stopped') connection.append(' ', button('Reconnect', () => { source?.close(); source = null; connectStream({ ...selectedStream }); }));
    connection.dataset.state = update.status === 'failed' ? 'error' : streamState;
    const updateButton = document.getElementById('update-button');
    updateButton.disabled = updateActive(update);
    updateButton.textContent = updateButton.disabled ? 'Update in progress…' : 'Update dashboard';
  }
  function expireSession() {
    if (expired) return;
    expired = true;
    source?.close();
    connection.dataset.state = 'error';
    connection.replaceChildren(document.createTextNode('Your session expired. '), element('a', { href: '/login', text: 'Sign in again' }));
    main.querySelectorAll('button[type="submit"], [data-run-button], [data-mutation]').forEach(node => { node.disabled = true; });
    document.getElementById('update-button').disabled = true;
    document.getElementById('logout-button').disabled = true;
  }
  async function request(url, options = {}) {
    if (expired) throw new Error('Your session expired. Sign in again.');
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...options, headers: { Accept: 'application/json', ...options.headers } });
    if (response.status === 401) { expireSession(); throw new Error('Your session expired. Sign in again.'); }
    let data;
    if (response.headers.get('content-type')?.includes('application/json')) data = await response.json();
    else throw new Error('The server returned an unexpected response. Reconnect or reload before trying again.');
    if (data.snapshot) acceptSnapshot(data.snapshot);
    if (!response.ok || data.ok === false) throw new Error(data.error || data.message || `Request failed (${response.status}).`);
    return data;
  }
  function post(url, body = new URLSearchParams()) {
    return request(url, { method: 'POST', headers: { 'X-CSRF-Token': bootstrap.csrfToken }, body });
  }
  function acceptSnapshot(next) {
    snapshot = next;
    showConnection();
    updateView();
  }
  function connectStream(selection = {}) {
    selectedStream = selection;
    const key = `${selection.jobId || ''}:${selection.runId || ''}`;
    if (source && key === streamKey) return;
    source?.close();
    if (expired) return;
    streamKey = key;
    const parameters = new URLSearchParams();
    if (selection.jobId) parameters.set('jobId', selection.jobId);
    if (selection.runId) { parameters.set('runId', selection.runId); parameters.set('offset', String(selection.offset || 0)); }
    streamState = 'connecting';
    showConnection();
    const stream = new EventSource(`/api/events${parameters.size ? `?${parameters}` : ''}`);
    source = stream;
    let checkedAuthentication = false;
    let checkedTerminalAuthentication = false;
    const listen = (name, callback) => stream.addEventListener(name, event => {
      if (stream !== source || expired) return;
      try { callback(JSON.parse(event.data)); }
      catch { streamState = 'reconnecting'; showConnection(); }
    });
    stream.onopen = () => { if (stream === source) { checkedAuthentication = false; checkedTerminalAuthentication = false; streamState = 'connected'; showConnection(); } };
    stream.onerror = () => {
      if (stream !== source || expired) return;
      streamState = 'reconnecting'; showConnection();
      // EventSource deliberately hides HTTP status. Check once per disconnect;
      // a later terminal error gets one additional check because it may be a
      // 401 received after the network recovered. Native EventSource owns
      // transient retries. A terminal rejection needs an explicit user retry.
      const terminal = stream.readyState === EventSource.CLOSED;
      if ((!terminal && !checkedAuthentication) || (terminal && !checkedTerminalAuthentication)) {
        if (terminal) checkedTerminalAuthentication = true; else checkedAuthentication = true;
        request('/api/jobs').catch(() => {}).finally(() => {
          if (terminal && stream === source && !expired) { streamState = 'stopped'; showConnection(); }
        });
      }
    };
    listen('snapshot', acceptSnapshot);
    listen('history', data => receiveHistory(data));
    listen('log', data => receiveLog(data));
    listen('auth-expired', expireSession);
  }
  function allowNavigation() { return !dirty() || window.confirm('Discard your unsaved changes?'); }
  async function recordActivity() {
    try { await post('/api/activity'); }
    catch (error) { if (!expired) announce(error.message, 'error'); }
  }
  function navigate(href, { replace = false, force = false } = {}) {
    const url = new URL(href, location.href);
    if (!force && !allowNavigation()) return false;
    if (replace) history.replaceState({}, '', url.pathname + url.search);
    else history.pushState({}, '', url.pathname + url.search);
    currentPath = location.pathname + location.search;
    renderRoute(true);
    recordActivity();
    return true;
  }
  window.addEventListener('popstate', () => {
    if (!allowNavigation()) { history.pushState({}, '', currentPath); return; }
    currentPath = location.pathname + location.search;
    renderRoute(true);
    recordActivity();
  });
  window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
  document.addEventListener('click', event => {
    const anchor = event.target.closest('a[data-nav]');
    if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || anchor.target || anchor.hasAttribute('download')) return;
    const url = new URL(anchor.href);
    if (url.origin !== location.origin) return;
    event.preventDefault(); navigate(url.href);
  });
  function heading(title, subtitle = '') {
    const titleNode = element('h1', { class: 'page-title', tabindex: '-1', text: title });
    const wrapper = element('div', { class: 'view-heading' }, [element('div', {}, [titleNode, subtitle ? element('p', { class: 'page-subtitle', text: subtitle }) : null])]);
    return { wrapper, titleNode };
  }
  async function runAction(target, url, message) {
    if (target.disabled) return;
    target.disabled = true;
    target.setAttribute('aria-busy', 'true');
    try { const result = await post(url); announce(result.message || message); }
    catch (error) { announce(error.message, 'error'); }
    finally { target.disabled = expired; target.removeAttribute('aria-busy'); updateView(); showConnection(); }
  }
  function renderDashboard() {
    const section = element('section', { class: 'scripts-section', 'aria-labelledby': 'scripts-heading' });
    const { wrapper, titleNode } = heading('Scripts'); titleNode.id = 'scripts-heading';
    const counts = element('div', { class: 'script-counts', 'aria-label': 'Script summary' });
    wrapper.firstChild.append(counts); wrapper.classList.add('section-toolbar');
    const actions = element('div', { class: 'view-actions' });
    const list = element('div', { id: 'scripts-list' });
    const rows = new Map();
    let order = [];
    let reordering = false;
    let draggedId;
    const status = element('p', { class: 'reorder-note', role: 'status', hidden: true });
    const reorderButton = button('Reorder', () => { reordering = true; order = snapshot.jobs.map(job => job.id); refresh(); });
    const cancelButton = button('Cancel', () => { reordering = false; refresh(); });
    const saveButton = button('Save order', async () => {
      saveButton.disabled = true;
      try {
        const names = order.map(id => snapshot.jobs.find(job => job.id === id)?.name);
        const result = await request('/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': bootstrap.csrfToken }, body: JSON.stringify({ order: names }) });
        reordering = false; announce(result.message || 'Script order saved.'); refresh();
      } catch (error) { announce(error.message, 'error'); }
      finally { saveButton.disabled = expired; }
    }, 'btn btn-primary');
    saveButton.setAttribute('data-mutation', '');
    actions.append(reorderButton, saveButton, cancelButton); wrapper.append(actions);
    const warning = element('div', { class: 'alert alert-error schedule-warning' });
    const panel = element('div', { class: 'panel' }, [element('div', { class: 'script-columns', 'aria-hidden': 'true' }, ['Script', 'Last run', 'Schedule', 'Actions'].map((text, index) => element('span', { class: index === 3 ? 'text-right' : '', text }))), list]);
    section.append(wrapper, warning, panel, status); main.append(section);
    const cronPanel = element('details', { class: 'panel cron-panel' }, [element('summary', { text: 'Crontab' })]);
    const cronOutput = element('pre', { class: 'cron-output', text: '' });
    cronPanel.append(cronOutput); main.append(cronPanel);
    cronPanel.addEventListener('toggle', async () => {
      if (!cronPanel.open) return;
      cronOutput.textContent = 'Loading current crontab…';
      try { const data = await request('/api/crontab'); cronOutput.textContent = data.text || 'No crontab entries.'; }
      catch (error) { cronOutput.textContent = error.message; }
    });
    function move(id, direction) {
      const index = order.indexOf(id); const next = index + direction;
      if (index < 0 || next < 0 || next >= order.length) return;
      [order[index], order[next]] = [order[next], order[index]];
      refresh();
      rows.get(id)?.querySelector(`[data-move="${direction < 0 ? 'up' : 'down'}"]`)?.focus();
      status.textContent = `${snapshot.jobs.find(job => job.id === id)?.name} moved ${direction < 0 ? 'up' : 'down'}.`;
    }
    function makeRow(job) {
      const row = element('article', { class: 'script-row', 'data-job-id': job.id, 'aria-label': job.name });
      const up = button('↑', () => move(job.id, -1), 'move-button'); up.dataset.move = 'up';
      const down = button('↓', () => move(job.id, 1), 'move-button'); down.dataset.move = 'down';
      const dragControls = element('div', { class: 'drag-controls' }, [element('span', { class: 'drag-handle', text: '⠿', 'aria-hidden': 'true' }), element('div', {}, [up, down])]);
      const name = element('h2', { class: 'script-name' });
      const meta = element('div', { class: 'script-meta' });
      row.append(element('div', { class: 'script-identity' }, [dragControls, element('div', { class: 'min-w-0' }, [name, meta])]));
      const last = element('p'); const progress = element('p');
      row.append(element('div', { class: 'script-last-run' }, [last, progress]));
      const paused = element('span', { class: 'schedule-state' });
      const toggle = button('', () => runAction(toggle, `/toggle_cron/${encodeURIComponent(row.dataset.name)}`, 'Schedule updated.'), 'schedule-button'); toggle.setAttribute('data-mutation', '');
      const schedule = element('span', { class: 'schedule-detail' });
      row.append(element('div', { class: 'schedule-content' }, [element('div', { class: 'schedule-control' }, [paused, toggle]), schedule]));
      const run = button('▷ Run', () => runAction(run, `/run/${encodeURIComponent(row.dataset.name)}`, 'Run queued.'), 'btn btn-run'); run.setAttribute('data-run-button', '');
      const edit = link('Edit', ''); const logs = link('History & logs', '');
      row.append(element('div', { class: 'script-actions' }, [run, edit, logs]));
      row.addEventListener('dragstart', event => { if (!reordering) { event.preventDefault(); return; } draggedId = job.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', job.id); row.classList.add('is-dragging'); });
      row.addEventListener('dragend', () => { draggedId = null; row.classList.remove('is-dragging'); });
      row.addEventListener('dragover', event => { if (reordering && draggedId) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } });
      row.addEventListener('drop', event => {
        if (!reordering || !draggedId || draggedId === job.id) return;
        event.preventDefault(); order.splice(order.indexOf(draggedId), 1); order.splice(order.indexOf(job.id), 0, draggedId); refresh();
        status.textContent = 'Script order changed. Save order to keep it.';
      });
      row.refresh = (value) => {
        row.dataset.name = value.name; row.setAttribute('aria-label', value.name);
        name.textContent = value.name; meta.replaceChildren(badge(value.status));
        last.textContent = value.status === 'running' ? 'In progress' : value.last_run ? date(value.last_run) : 'Never';
        progress.textContent = value.message || '';
        paused.textContent = value.paused ? 'Paused' : 'Active'; paused.classList.toggle('is-paused', Boolean(value.paused));
        toggle.textContent = value.paused ? 'Resume' : 'Pause'; toggle.setAttribute('aria-label', `${value.paused ? 'Resume' : 'Pause'} cron for ${value.name}`);
        toggle.disabled = expired || Boolean(snapshot.contentRecovery);
        schedule.textContent = value.timer || value.schedule || '';
        run.disabled = expired || snapshot.schedulerPending || ['queued', 'running'].includes(value.status);
        run.setAttribute('aria-label', `Run ${value.name}`);
        edit.href = pathFor(value, 'edit'); edit.setAttribute('aria-label', `Edit ${value.name}`);
        logs.href = pathFor(value, 'log'); logs.setAttribute('aria-label', `History and logs for ${value.name}`);
        up.setAttribute('aria-label', `Move ${value.name} up`); down.setAttribute('aria-label', `Move ${value.name} down`);
        row.draggable = reordering;
      };
      return row;
    }
    function refresh() {
      const jobs = snapshot.jobs;
      counts.replaceChildren(...[`${jobs.length} ${jobs.length === 1 ? 'script' : 'scripts'}`, `${jobs.filter(job => job.status === 'running').length} running`, `${jobs.filter(job => job.paused).length} paused`].map(text => element('span', { text })));
      warning.hidden = !snapshot.schedulerPending && !snapshot.contentRecovery;
      if (!warning.hidden) {
        warning.replaceChildren(element('p', { text: snapshot.contentRecovery ? 'A file edit was interrupted. Restore its original files before synchronizing schedules.' : 'Schedules need synchronization. Execution is paused.' }));
        const retry = button(snapshot.contentRecovery ? 'Recover interrupted edit' : 'Retry schedule sync', () => runAction(retry, snapshot.contentRecovery ? '/recover-edit' : '/sync-cron', 'Schedules updated.'), 'btn'); retry.setAttribute('data-mutation', ''); retry.disabled = expired; warning.append(retry);
      }
      const ids = new Set(jobs.map(job => job.id));
      for (const [id, row] of rows) if (!ids.has(id)) { row.remove(); rows.delete(id); }
      if (reordering) order = [...order.filter(id => ids.has(id)), ...jobs.map(job => job.id).filter(id => !order.includes(id))];
      else order = jobs.map(job => job.id);
      for (const [index, id] of order.entries()) {
        const job = jobs.find(value => value.id === id);
        let row = rows.get(id);
        if (!row) { row = makeRow(job); rows.set(id, row); }
        row.refresh(job);
        if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
      }
      panel.querySelector('.script-columns').hidden = !jobs.length;
      list.querySelector('.empty-state')?.remove();
      if (!jobs.length) list.append(element('div', { class: 'empty-state' }, [element('p', { text: 'No scripts yet.' }), link('New script', '/new', 'btn btn-primary')]));
      list.classList.toggle('is-reordering', reordering);
      reorderButton.hidden = reordering || jobs.length < 2; saveButton.hidden = !reordering; cancelButton.hidden = !reordering;
      status.hidden = !reordering; if (reordering && !status.textContent) status.textContent = 'Drag to reorder, or use the arrow buttons.';
    }
    updateView = refresh; dirty = () => reordering; refresh();
  }
  function loadMonaco() {
    if (monacoPromise) return monacoPromise;
    monacoPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Editors could not load. Reload before saving. Your files have not changed.')), 15000);
      if (!window.require) { clearTimeout(timeout); reject(new Error('Editors could not load. Reload before saving.')); return; }
      window.require.config({ paths: { vs: '/vendor/monaco/vs' } });
      window.require(['vs/editor/editor.main'], () => { clearTimeout(timeout); resolve(window.monaco); }, () => { clearTimeout(timeout); reject(new Error('Editors could not load. Reload before saving.')); });
    });
    return monacoPromise;
  }
  async function renderForm(job, isNew, version) {
    const { wrapper, titleNode } = heading(isNew ? 'New script' : job.name, isNew ? 'Add a script to the dashboard' : 'Edit script');
    wrapper.append(link('Back to scripts', '/')); main.append(wrapper);
    const loading = element('p', { class: 'page-subtitle', role: 'status', text: 'Loading script…' }); main.append(loading);
    let data = { ...(bootstrap.defaults || {}) };
    try {
      if (!isNew) data = (await request(`/api/jobs/${encodeURIComponent(job.id)}/editor`)).job;
      if (version !== routeVersion) return;
      loading.remove();
      data.timer = data.timer || data.schedule || '0 0 * * *';
      data.log_mode = data.log_mode || 'stdout';
      const form = element('form', { class: 'panel form-panel', 'aria-label': 'Script details' });
      const fields = new Map();
      const grid = element('div', { class: 'fields-grid' });
      function field(name, label, { required = true, wide = false, help = '', options } = {}) {
        const input = options ? element('select', { id: name, name, class: 'input' }, options.map(([value, text]) => element('option', { value, text }))) : element('input', { id: name, name, type: 'text', class: `input${name === 'name' ? '' : ' font-mono'}`, required });
        input.value = data[name] || ''; fields.set(name, input);
        const container = element('div', { class: wide ? 'field-wide' : '' }, [element('label', { for: name, class: 'field-label', text: label }), input]);
        if (help) container.append(element('p', { class: 'field-help', text: help }));
        return container;
      }
      grid.append(field('name', 'Name'), field('timer', 'Cron schedule'), field('script', 'Script path', { wide: true }), field('log_mode', 'Log source', { options: [['stdout', 'Console output (stdout/stderr)'], ['file', 'Script writes the log file']], help: 'Capture one source. File mode follows appended output in the configured log.' }), field('log', 'Log path'), field('lock', 'Lock path'));
      form.append(grid);
      const scriptEditorNode = element('div', { class: 'editor-frame script-editor', 'aria-label': 'Script editor' });
      const scriptSection = element('section', { class: 'form-section', 'aria-labelledby': 'script-heading' });
      const scriptActions = element('div', { class: 'editor-actions' });
      scriptSection.append(element('div', { class: 'form-section-heading' }, [element('h2', { id: 'script-heading', text: 'Script' }), scriptActions]), scriptEditorNode); form.append(scriptSection);
      let configEnabled = Boolean(data.config_path);
      const configToggle = button(configEnabled ? 'Enabled' : 'Disabled', () => {
        configEnabled = !configEnabled;
        configToggle.textContent = configEnabled ? 'Enabled' : 'Disabled'; configToggle.setAttribute('aria-pressed', String(configEnabled));
        configSection.hidden = !configEnabled; configEditor?.layout();
      });
      configToggle.id = 'config-toggle'; configToggle.setAttribute('aria-controls', 'config-section'); configToggle.setAttribute('aria-label', 'Enable config file'); configToggle.setAttribute('aria-pressed', String(configEnabled));
      const configSection = element('div', { id: 'config-section', hidden: !configEnabled }, [field('config_path', 'Config path', { required: false })]);
      const configEditorNode = element('div', { class: 'editor-frame config-editor', 'aria-label': 'Config editor' });
      const configActions = element('div', { class: 'editor-actions' }); configSection.append(configEditorNode, configActions);
      form.append(element('section', { class: 'form-section', 'aria-labelledby': 'config-heading' }, [element('div', { class: 'form-section-heading' }, [element('h2', { id: 'config-heading', text: 'Config file' }), configToggle]), configSection]));
      const editorStatus = element('p', { id: 'editor-loading', class: 'editor-status', role: 'status', text: 'Loading editors…' });
      const save = element('button', { id: 'save-script', type: 'submit', class: 'btn btn-primary', disabled: true, text: isNew ? 'Add script' : 'Save changes' });
      form.append(element('div', { class: 'form-actions' }, [editorStatus, link('Cancel', '/'), save])); main.append(form);
      let editor; let configEditor; let ready = false; let saving = false; let initial;
      const getValues = () => ({ ...Object.fromEntries([...fields].map(([key, input]) => [key, input.value])), content: ready ? editor.getValue() : data.content || '', config_content: ready ? configEditor.getValue() : data.config_content || '', config_enabled: String(configEnabled) });
      initial = JSON.stringify(getValues()); dirty = () => JSON.stringify(getValues()) !== initial;
      const dark = window.matchMedia('(prefers-color-scheme: dark)');
      const applyTheme = () => window.monaco?.editor.setTheme(dark.matches ? 'vs-dark' : 'vs');
      disposeView = () => { dark.removeEventListener('change', applyTheme); const models = [editor?.getModel(), configEditor?.getModel()]; editor?.dispose(); configEditor?.dispose(); models.forEach(model => model?.dispose()); };
      function editorButtons(container, getEditor, description) {
        const clear = button(`Clear ${description}`, () => { const value = getEditor(); if (value?.getValue() && window.confirm(`Clear this ${description}? Changes are only saved when you save the form.`)) { value.setValue(''); value.focus(); } });
        const copy = button(`Copy ${description}`, async () => {
          try { await navigator.clipboard.writeText(getEditor().getValue()); announce(`${description === 'script' ? 'Script' : 'Config'} copied.`); }
          catch { announce('Unable to copy. Select the editor text and copy it with your keyboard.', 'error'); }
        });
        clear.disabled = true; copy.disabled = true; container.append(clear, copy); return [clear, copy];
      }
      const tools = [...editorButtons(scriptActions, () => editor, 'script'), ...editorButtons(configActions, () => configEditor, 'config')];
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!ready || saving || expired) return;
        if (configEnabled && !fields.get('config_path').value.trim()) { fields.get('config_path').focus(); announce('Enter a config path or disable the config file.', 'error'); return; }
        saving = true; save.disabled = true; save.setAttribute('aria-busy', 'true');
        const body = new URLSearchParams({ ...getValues(), editor_ready: 'true' });
        if (!isNew && typeof data.revision === 'string') body.set('revision', data.revision);
        try {
          const result = await post(isNew ? '/new' : pathFor(job, 'edit'), body);
          if (version !== routeVersion) return;
          initial = JSON.stringify(getValues()); announce(result.message || 'Script saved.'); navigate('/', { force: true });
        } catch (error) { announce(error.message, 'error'); }
        finally { saving = false; save.disabled = !ready || expired; save.removeAttribute('aria-busy'); }
      });
      try {
        const monaco = await loadMonaco(); if (version !== routeVersion) return;
        const options = { automaticLayout: true, theme: dark.matches ? 'vs-dark' : 'vs', minimap: { enabled: false }, fontFamily: "'Cascadia Code', 'Menlo', monospace" };
        editor = monaco.editor.create(scriptEditorNode, { ...options, value: data.content || '', language: 'shell' });
        configEditor = monaco.editor.create(configEditorNode, { ...options, value: data.config_content || '', language: 'yaml' });
        ready = true; save.disabled = expired; tools.forEach(tool => { tool.disabled = false; }); editorStatus.textContent = '';
        dark.addEventListener('change', applyTheme);
      } catch (error) { if (version === routeVersion) { editorStatus.textContent = error.message; editorStatus.setAttribute('role', 'alert'); } }
    } catch (error) { if (version === routeVersion) { loading.textContent = error.message; loading.setAttribute('role', 'alert'); } }
    titleNode.textContent = isNew ? 'New script' : job.name;
  }
  function renderRuns(job) {
    const { wrapper } = heading(job.name, `Run history & live logs · ${bootstrap.retentionDays || 30} days retained`); wrapper.append(link('Back to scripts', '/')); main.append(wrapper);
    const body = element('tbody', { id: 'runs' });
    const table = element('table', { class: 'run-history' }, [element('caption', { text: 'Recent runs, newest first' }), element('thead', {}, [element('tr', {}, ['Outcome', 'Started / finished', 'Duration', 'Source', 'Exit', 'Log'].map(text => element('th', { scope: 'col', text })))]), body]);
    const empty = element('p', { class: 'empty-history', text: 'Waiting for run history…' });
    const older = button('Load older runs', async () => {
      older.disabled = true;
      try {
        const data = await request(`/api/jobs/${encodeURIComponent(job.id)}/runs?before=${encodeURIComponent(oldestCursor)}`);
        if (selectedStream.jobId !== job.id) return;
        for (const run of data.runs) { known.set(run.id, run); if (!order.includes(run.id)) order.push(run.id); }
        oldestCursor = data.runs.at(-1)?.id || oldestCursor; hasOlder = data.runs.length === 50; loadedOlder = true; paintHistory();
      } catch (error) { announce(error.message, 'error'); }
      finally { older.disabled = expired; }
    }); older.hidden = true;
    main.append(element('section', { class: 'panel', 'aria-label': 'Run history' }, [element('div', { class: 'history-scroll' }, [table]), empty, element('div', { class: 'history-footer' }, [older])]));
    const title = element('p', { id: 'selected-run', text: 'Select a run to view its log.' });
    const follow = element('input', { id: 'follow-tail', type: 'checkbox', checked: true });
    const toolbarActions = element('div', { class: 'view-actions' }, [element('label', { class: 'follow-control', for: 'follow-tail' }, [follow, 'Follow output'])]);
    if (job.log) toolbarActions.append(element('a', { href: `/legacy-log/${encodeURIComponent(job.name)}`, class: 'btn btn-ghost', target: '_blank', rel: 'noopener', text: 'Original script log ↗' }));
    const notice = element('p', { class: 'log-notice', role: 'status' });
    const output = element('pre', { class: 'editor-frame log-output', tabindex: '0', 'aria-label': 'Captured run log' });
    main.append(element('section', { class: 'panel log-panel', 'aria-label': 'Log output' }, [element('div', { class: 'log-toolbar' }, [title, toolbarActions]), notice, output]));
    const known = new Map(); let order = []; let loadedOlder = false; let oldestCursor; let hasOlder = false;
    let selectedId = new URLSearchParams(location.search).get('run'); let offset = 0; let visibleText = ''; let clipped = false; let historyReceived = false;
    if (selectedId && !/^[A-Za-z0-9_-]{1,128}$/.test(selectedId)) {
      selectedId = null;
      const url = new URL(location.href); url.searchParams.delete('run'); history.replaceState({}, '', url.pathname + url.search); currentPath = location.pathname + location.search;
      announce('The selected run is invalid. Select a run from the history.', 'error');
    }
    const encodeLog = new TextEncoder(); const decodeLog = new TextDecoder();
    function paintHistory() {
      const focused = body.contains(document.activeElement) ? document.activeElement.dataset.runId : null;
      const scroll = body.parentElement.parentElement.scrollTop;
      body.replaceChildren(...order.map(id => {
        const run = known.get(id); const row = element('tr', { 'aria-selected': String(id === selectedId) });
        row.append(element('td', {}, [badge(run.status)]), element('td', {}, [date(runTime(run)), run.finished_at ? element('span', { class: 'history-time', text: `Finished ${date(run.finished_at)}` }) : null]), element('td', { text: duration(run) }), element('td', { text: run.source || '—' }), element('td', { text: run.exit_code ?? '—' }));
        const view = button(id === selectedId ? 'Viewing' : 'View log', () => selectRun(id)); view.dataset.runId = id; view.setAttribute('aria-label', `View ${labels[run.status] || run.status} run from ${date(runTime(run))}`);
        row.append(element('td', {}, [view])); return row;
      }));
      empty.hidden = order.length > 0; if (historyReceived) empty.textContent = 'No runs recorded yet. New executions will appear here.';
      older.hidden = !hasOlder; body.parentElement.parentElement.scrollTop = scroll;
      if (focused) body.querySelector(`[data-run-id="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
      const run = known.get(selectedId);
      if (run) title.textContent = `${labels[run.status] || run.status} · ${date(runTime(run))}${run.message ? ` · ${run.message}` : ''}`;
    }
    function selectRun(id, { initial = false } = {}) {
      if (id === selectedId && !initial) return;
      selectedId = id; offset = 0; visibleText = ''; clipped = false; output.textContent = ''; notice.textContent = '';
      if (!initial) {
        const url = new URL(location.href); url.searchParams.set('run', id); history.pushState({}, '', url.pathname + url.search); currentPath = location.pathname + location.search; recordActivity();
      }
      paintHistory(); connectStream({ jobId: job.id, runId: id, offset });
    }
    receiveHistory = data => {
      if (data.jobId !== job.id || !Array.isArray(data.runs)) return;
      historyReceived = true;
      const freshIds = data.runs.map(run => run.id);
      for (const run of data.runs) known.set(run.id, run);
      order = loadedOlder ? [...freshIds, ...order.filter(id => !freshIds.includes(id))] : freshIds;
      if (!loadedOlder) { oldestCursor = order.at(-1); hasOlder = data.runs.length === 50; }
      paintHistory(); if (!selectedId && order.length) selectRun(order[0], { initial: true });
    };
    receiveLog = data => {
      if (data.runId !== selectedId) return;
      if (data.run) known.set(data.run.id, data.run);
      const start = Number(data.offset); const next = Number(data.nextOffset);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(next) || start < 0 || next < start) return;
      if (start > offset) {
        notice.textContent = 'A log segment was missed. Reconnecting from the last received byte…';
        source?.close(); source = null; connectStream({ jobId: job.id, runId: selectedId, offset }); return;
      }
      let addition = data.text || '';
      if (next > offset && start < offset) addition = decodeLog.decode(encodeLog.encode(addition).subarray(offset - start));
      if (next > offset) {
        const previousTop = output.scrollTop;
        visibleText += addition;
        // Keep the text being read in place while following is paused. The
        // retained run itself is bounded; trim only when following the tail.
        if (follow.checked && visibleText.length > 65536) {
          const bytes = encodeLog.encode(visibleText);
          if (bytes.length > 262144) {
            let start = bytes.length - 262144;
            while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
            visibleText = decodeLog.decode(bytes.subarray(start)); clipped = true;
          }
        }
        output.textContent = visibleText;
        offset = next; selectedStream.offset = offset;
        if (follow.checked) output.scrollTop = output.scrollHeight; else output.scrollTop = previousTop;
      }
      const notes = [];
      if (data.expired) notes.push('Run history expired. Select another run.');
      if (data.truncated) notes.push('Capture reached its size limit. The job continued.');
      if (data.captureGap) notes.push('The script log was reset or replaced; some output may be missing.');
      if (clipped) notes.push(follow.checked ? 'Showing the latest 256 KiB of captured output.' : 'Earlier output was hidden. Following is paused to preserve your reading position.');
      if (data.complete && !data.expired) notes.push('This run is complete.');
      notice.textContent = notes.join(' '); paintHistory();
      if (data.expired) title.textContent = 'Run history expired or unavailable.';
    };
    follow.addEventListener('change', () => { if (follow.checked) output.scrollTop = output.scrollHeight; });
    output.addEventListener('scroll', () => { if (output.scrollHeight - output.clientHeight - output.scrollTop > 36) follow.checked = false; });
    updateView = () => {
      const current = snapshot.jobs.find(value => value.id === job.id);
      if (current) wrapper.querySelector('h1').textContent = current.name;
    };
    if (selectedId) selectRun(selectedId, { initial: true }); else connectStream({ jobId: job.id });
  }
  function renderRoute(focus = false) {
    const version = ++routeVersion;
    disposeView(); disposeView = () => {}; dirty = () => false; updateView = () => {}; receiveHistory = () => {}; receiveLog = () => {};
    // A view change must receive its own initial snapshot/history, even if it
    // selects the same job or run as the previous view.
    streamKey = null;
    main.replaceChildren(); main.setAttribute('aria-busy', 'false');
    const parts = location.pathname.split('/').filter(Boolean);
    let name;
    try { name = parts[1] ? decodeURIComponent(parts.slice(1).join('/')) : ''; }
    catch { name = ''; }
    const job = snapshot.jobs.find(value => value.name === name || value.id === name);
    if (!parts.length) { renderDashboard(); connectStream(); }
    else if (parts[0] === 'new' && parts.length === 1) { renderForm({}, true, version); connectStream(); }
    else if (parts[0] === 'edit' && job) { renderForm(job, false, version); connectStream(); }
    else if (parts[0] === 'log' && job) renderRuns(job);
    else {
      const { wrapper } = heading('Script unavailable', 'The script may have been renamed or removed.'); main.append(wrapper, link('Back to scripts', '/')); connectStream();
    }
    document.title = `${parts.length ? parts[0] === 'new' ? 'New script' : job ? `${parts[0] === 'edit' ? 'Edit' : 'Runs'} · ${job.name}` : 'Script unavailable' : 'Scripts'} · Pi Script Dashboard`;
    if (focus) { main.querySelector('h1')?.focus({ preventScroll: true }); window.scrollTo(0, 0); }
  }
  document.getElementById('update-button').addEventListener('click', event => {
    if (!allowNavigation()) return;
    runAction(event.currentTarget, '/update', 'Dashboard update requested. Progress will arrive through live updates.');
  });
  document.getElementById('logout-button').addEventListener('click', async event => {
    if (!allowNavigation()) return;
    const target = event.currentTarget; target.disabled = true;
    try { const result = await post('/logout'); dirty = () => false; source?.close(); location.assign(result.redirect || '/login'); }
    catch (error) { announce(error.message, 'error'); target.disabled = expired; }
  });
  const menu = document.querySelector('.utility-menu');
  document.addEventListener('click', event => { if (!menu.contains(event.target)) menu.open = false; });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); } });
  for (const message of bootstrap.messages || []) announce(message.text, message.category);
  renderRoute();
})();
