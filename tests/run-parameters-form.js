'use strict';

/* global describe, it, expect */
// Run form and editor of public/js/run-parameters.js against a minimal DOM, in a separate
// context that also loads the shared rules exactly as the browser does.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createDom() {
  const registry = new Map();
  const dom = { activeElement: null, cookie: '' };
  function element(tag) {
    const node = {
      tagName: tag.toUpperCase(), children: [], parent: null, attributes: {}, listeners: {}, dataset: {},
      value: '', checked: false, disabled: false, textContent: '', type: '', classes: new Set(),
      get className() { return [...this.classes].join(' '); },
      set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); },
      get id() { return this.attributes.id || ''; },
      set id(value) { this.attributes.id = value; registry.set(value, this); },
      appendChild(child) { child.parent = this; this.children.push(child); return child; },
      append(...children) { children.forEach((child) => this.appendChild(child)); },
      replaceChildren(...children) { this.children = []; children.forEach((child) => this.appendChild(child)); },
      setAttribute(name, value) { if (name === 'id') this.id = value; else this.attributes[name] = String(value); },
      getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
      removeAttribute(name) { delete this.attributes[name]; },
      addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); },
      removeEventListener(name, callback) { this.listeners[name] = (this.listeners[name] || []).filter((item) => item !== callback); },
      dispatch(name) { (this.listeners[name] || []).slice().forEach((callback) => callback({ preventDefault() {} })); },
      focus() { dom.activeElement = this; },
      descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); },
      querySelectorAll(selector) { return select(this, selector); },
      querySelector(selector) { return select(this, selector)[0] || null; },
    };
    node.classList = {
      add: (name) => node.classes.add(name),
      remove: (name) => node.classes.delete(name),
      contains: (name) => node.classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !node.classes.has(name) : Boolean(force);
        if (on) node.classes.add(name); else node.classes.delete(name);
        return on;
      },
    };
    return node;
  }
  // Supports only the selectors used by run-parameters.js.
  function select(scope, selector) {
    let rest = selector;
    const scoped = /^#([\w-]+)\s+(.*)$/.exec(selector);
    if (scoped) {
      scope = registry.get(scoped[1]);
      rest = scoped[2];
    }
    if (!scope) return [];
    const nodes = scope.descendants();
    if (rest === 'input[type="checkbox"]') return nodes.filter((node) => node.tagName === 'INPUT' && node.type === 'checkbox');
    if (rest === 'input:not([disabled]), select:not([disabled])') {
      return nodes.filter((node) => (node.tagName === 'INPUT' || node.tagName === 'SELECT') && !node.disabled);
    }
    throw new Error(`Unsupported selector ${selector}`);
  }
  dom.createElement = element;
  dom.getElementById = (id) => registry.get(id) || null;
  dom.querySelectorAll = (selector) => select(null, selector);
  for (const id of ['job-run-parameters', 'job-add-run-parameter', 'run-parameters-unsupported', 'run-parameters-modal',
    'run-parameters-task', 'run-parameters-form', 'run-parameters-fields', 'run-parameters-confirmations',
    'run-parameters-confirm-list', 'run-parameters-preview', 'run-parameters-error', 'run-parameters-submit']) {
    element(id === 'run-parameters-form' ? 'form' : 'div').id = id;
  }
  return dom;
}

function deferred() {
  const callbacks = { done: [], fail: [] };
  return {
    done(callback) { callbacks.done.push(callback); return this; },
    fail(callback) { callbacks.fail.push(callback); return this; },
    resolve(value) { callbacks.done.forEach((callback) => callback(value)); },
    reject(value) { callbacks.fail.forEach((callback) => callback(value)); },
  };
}

function loadClient(role) {
  const dom = createDom();
  const requests = [];
  const modal = { shown: 0, hidden: 0 };
  const context = {
    document: dom,
    bootstrap: { Modal: { getOrCreateInstance: () => ({ show() { modal.shown += 1; }, hide() { modal.hidden += 1; } }) } },
    $: { ajax(options) { const response = deferred(); requests.push({ options, response }); return response; } },
  };
  context.window = context;
  vm.createContext(context);
  const rulesSource = fs.readFileSync(path.join(__dirname, '..', 'config', 'run-parameters.js'), 'utf8');
  vm.runInContext(`(function () { var module = { exports: {} };\n${rulesSource}\nwindow.CrontabRunParameterRules = module.exports; })();`, context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'run-parameters.js'), 'utf8'), context);
  const client = context.CrontabRunParameters;
  client.init({ role, tr: (key, values) => (values ? `${key} ${JSON.stringify(values)}` : key) });
  client.bind();
  const parse = (value) => vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`, context);
  const job = parse({
    _id: 'job-1', name: 'Pagamentos Siebel', execution_mode: 'structured', stopped: false,
    structured_execution: {
      environment_id: 'env-1', script_path: '/opt/etl/main.py', arguments: ['--verbose'],
      run_parameters: [
        { name: 'date', flag: '--date', type: 'date', label: 'Processing date', help: 'Empty: the script decides.' },
        { name: 'delete', flag: '--delete', type: 'flag', label: 'Delete', confirm: true, min_role: 'operator' },
        { name: 'mode', flag: '--mode', type: 'select', label: 'Mode', style: 'equals', options: [{ value: 'full', label: 'Full' }] },
      ],
    },
  });
  return { client, dom, get: dom.getElementById, job, requests, modal, parse };
}

function setValue(input, value) {
  if (input.type === 'checkbox') {
    input.checked = value;
    input.dispatch('change');
  } else {
    input.value = value;
    input.dispatch(input.tagName === 'SELECT' ? 'change' : 'input');
  }
}

describe('Run parameters form', () => {
  it('renders the fields, previews the argv and blocks parameters above the role', () => {
    const { client, get, job, modal, dom } = loadClient('executor');
    client.openRunForm(job, {
      environment: { executable_path: '/opt/etl/venv/bin/python', runtime_type: 'python', target_id: 'native-local' },
      runUrl: '/runjob', onStarted() {},
    });
    expect(modal.shown).toBe(1);
    expect(get('run-parameters-task').textContent).toBe('Pagamentos Siebel · python · native-local');
    expect(get('run-param-date').type).toBe('text');
    expect(get('run-param-date').placeholder).toBe('YYYY-MM-DD');
    expect(get('run-param-date').getAttribute('aria-describedby')).toBe('run-param-date-flag run-param-date-help run-param-date-error');
    expect(get('run-param-delete').disabled).toBe(true);
    expect(get('run-param-delete-role').textContent).toBe('runParameterRequiresRole {"role":"operator"}');
    expect(JSON.parse(get('run-parameters-preview').textContent))
      .toEqual(['/opt/etl/venv/bin/python', '/opt/etl/main.py', '--verbose']);

    setValue(get('run-param-date'), '2026-11-15');
    setValue(get('run-param-mode'), 'full');
    expect(JSON.parse(get('run-parameters-preview').textContent))
      .toEqual(['/opt/etl/venv/bin/python', '/opt/etl/main.py', '--verbose', '--date', '2026-11-15', '--mode=full']);
    expect(get('run-parameters-submit').disabled).toBe(false);
    expect(get('run-parameters-confirmations').classList.contains('d-none')).toBe(true);

    get('run-parameters-modal').dispatch('shown.bs.modal');
    expect(dom.activeElement).toBe(get('run-param-date'));
  });

  it('requires confirming destructive options and submits only the defined values', () => {
    const { client, get, job, requests, modal } = loadClient('admin');
    const started = [];
    client.openRunForm(job, { environment: null, runUrl: '/runjob', onStarted: (operationId) => started.push(operationId) });
    setValue(get('run-param-delete'), true);
    expect(get('run-parameters-confirmations').classList.contains('d-none')).toBe(false);
    expect(get('run-parameters-submit').disabled).toBe(true);
    setValue(get('run-confirm-delete'), true);
    expect(get('run-parameters-submit').disabled).toBe(false);

    get('run-parameters-form').dispatch('submit');
    expect(requests).toHaveLength(1);
    expect(requests[0].options).toMatchObject({ url: '/runjob', method: 'POST', contentType: 'application/json' });
    expect(JSON.parse(requests[0].options.data)).toEqual({
      _id: 'job-1', parameters: { date: '', delete: true, mode: '' }, confirmed: ['delete'],
    });
    expect(get('run-parameters-submit').disabled).toBe(true);
    requests[0].response.resolve({ operationId: 'operation-1' });
    expect(modal.hidden).toBe(1);
    expect(started).toEqual(['operation-1']);
  });

  it('shows validation and server errors next to the field and keeps the form open', () => {
    const { client, get, job, requests, modal } = loadClient('admin');
    client.openRunForm(job, { environment: null, runUrl: '/runjob', onStarted() {} });
    setValue(get('run-param-date'), '2026-02-30');
    expect(get('run-param-date-error').textContent).toMatch(/valid date/);
    expect(get('run-param-date').getAttribute('aria-invalid')).toBe('true');
    expect(get('run-parameters-submit').disabled).toBe(true);

    setValue(get('run-param-date'), '2026-11-15');
    expect(get('run-param-date').getAttribute('aria-invalid')).toBeNull();
    get('run-parameters-form').dispatch('submit');
    requests[0].response.reject({ responseJSON: { message: 'Parameter date is outside the allowed date range', parameter: 'date' } });
    expect(get('run-param-date-error').textContent).toBe('Parameter date is outside the allowed date range');
    expect(get('run-parameters-submit').disabled).toBe(false);

    get('run-parameters-form').dispatch('submit');
    requests[1].response.reject({ responseJSON: { message: 'Execution environment must be validated before use', code: 'ENVIRONMENT_NOT_VALIDATED' } });
    expect(get('run-parameters-error').textContent).toBe('Execution environment must be validated before use');
    expect(get('run-parameters-error').classList.contains('d-none')).toBe(false);
    expect(modal.hidden).toBe(0);
  });

  it('masks dates as ISO YYYY-MM-DD and waits for a complete date before showing an error', () => {
    const { client, get, job } = loadClient('admin');
    client.openRunForm(job, { environment: null, runUrl: '/runjob', onStarted() {} });
    expect(get('run-param-date-flag').textContent).toBe('runParameterArgument {"flag":"--date"} \u00b7 YYYY-MM-DD');
    get('run-param-date').focus();
    setValue(get('run-param-date'), '202611');
    expect(get('run-param-date').value).toBe('2026-11');
    expect(get('run-param-date').getAttribute('aria-invalid')).toBeNull();
    expect(get('run-parameters-submit').disabled).toBe(true);
    setValue(get('run-param-date'), '15/11/2026');
    expect(get('run-param-date').value).toBe('1511-20-26');
    expect(get('run-param-date').getAttribute('aria-invalid')).toBe('true');
    setValue(get('run-param-date'), '20261115');
    expect(get('run-param-date').value).toBe('2026-11-15');
    expect(get('run-parameters-submit').disabled).toBe(false);
    expect(JSON.parse(get('run-parameters-preview').textContent)).toEqual(['/opt/etl/main.py', '--verbose', '--date', '2026-11-15']);
  });

  it('picks a date from an English calendar that respects the limits', () => {
    const { client, get, parse } = loadClient('executor');
    const job = parse({
      _id: 'job-2', name: 'Limited', structured_execution: {
        environment_id: 'env-1', script_path: '/opt/etl/main.py', arguments: [],
        run_parameters: [
          { name: 'date', flag: '--date', type: 'date', label: 'Date', min: '2026-11-10', max: '2026-12-05' },
          { name: 'purge', flag: '--purge-before', type: 'date', label: 'Purge', min_role: 'admin' },
        ],
      },
    });
    client.openRunForm(job, { environment: null, runUrl: '/runjob', onStarted() {} });
    const toggle = get('run-param-date').pickerToggle;
    expect(toggle.getAttribute('aria-label')).toBe('runParameterOpenCalendar');
    expect(get('run-param-purge').pickerToggle.disabled).toBe(true);

    setValue(get('run-param-date'), '2026-11-15');
    toggle.dispatch('click');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const panel = get('run-param-date-calendar');
    const nodes = () => panel.descendants();
    const day = (iso) => nodes().find((node) => node.getAttribute('data-date') === iso);
    expect(nodes().find((node) => node.className === 'run-date-picker-title').textContent).toBe('November 2026');
    expect(nodes().filter((node) => node.className === 'run-date-picker-weekday').map((node) => node.textContent))
      .toEqual(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
    expect(day('2026-11-09').disabled).toBe(true);
    expect(day('2026-11-15').getAttribute('aria-pressed')).toBe('true');
    expect(day('2026-11-15').tabIndex).toBe(0);

    // Arrow keys move the focus, across months when needed.
    day('2026-11-30').listeners.keydown[0]({ key: 'ArrowRight', preventDefault() {} });
    expect(nodes().find((node) => node.className === 'run-date-picker-title').textContent).toBe('December 2026');
    expect(day('2026-12-06').disabled).toBe(true);

    day('2026-12-02').dispatch('click');
    expect(get('run-param-date').value).toBe('2026-12-02');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(get('run-parameters-preview').textContent)).toEqual(['/opt/etl/main.py', '--date', '2026-12-02']);

    toggle.dispatch('click');
    const clear = get('run-param-date-calendar').descendants().find((node) => node.textContent === 'Clear');
    clear.dispatch('click');
    expect(get('run-param-date').value).toBe('');
  });

  it('takes a month as YYYY-MM from the field or from a calendar of months', () => {
    const { client, get, parse } = loadClient('executor');
    const job = parse({
      _id: 'job-3', name: 'Monthly', structured_execution: {
        environment_id: 'env-1', script_path: '/opt/etl/main.py', arguments: [],
        run_parameters: [{ name: 'period', flag: '--date', type: 'month', label: 'Period', style: 'equals', min: '2025-03' }],
      },
    });
    client.openRunForm(job, { environment: null, runUrl: '/runjob', onStarted() {} });
    const input = get('run-param-period');
    expect(input.placeholder).toBe('YYYY-MM');
    expect(input.maxLength).toBe(7);
    input.focus();
    setValue(input, '2025-1');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(get('run-parameters-submit').disabled).toBe(true);
    setValue(input, '202512');
    expect(input.value).toBe('2025-12');
    expect(JSON.parse(get('run-parameters-preview').textContent)).toEqual(['/opt/etl/main.py', '--date=2025-12']);
    setValue(input, '202502');
    expect(input.getAttribute('aria-invalid')).toBe('true');

    setValue(input, '2025-12');
    input.pickerToggle.dispatch('click');
    const panel = get('run-param-period-calendar');
    const nodes = () => panel.descendants();
    const cell = (iso) => nodes().find((node) => node.getAttribute('data-date') === iso);
    expect(panel.getAttribute('aria-label')).toBe('Choose month');
    expect(nodes().find((node) => node.className === 'run-date-picker-title').textContent).toBe('2025');
    expect(nodes().filter((node) => node.getAttribute('data-date')).map((node) => node.textContent))
      .toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
    expect(cell('2025-02').disabled).toBe(true);
    expect(cell('2025-12').getAttribute('aria-pressed')).toBe('true');
    expect(nodes().some((node) => node.textContent === 'This month')).toBe(true);

    // Arrow down moves three months, into the next year.
    cell('2025-12').listeners.keydown[0]({ key: 'ArrowDown', preventDefault() {} });
    expect(nodes().find((node) => node.className === 'run-date-picker-title').textContent).toBe('2026');
    cell('2026-03').dispatch('click');
    expect(input.value).toBe('2026-03');
    expect(JSON.parse(get('run-parameters-preview').textContent)).toEqual(['/opt/etl/main.py', '--date=2026-03']);
  });

  it('explains an incomplete date once the field loses focus instead of only disabling Run', () => {
    const { client, get, job, dom } = loadClient('admin');
    client.openRunForm(job, { environment: null, runUrl: '/runjob', onStarted() {} });
    const input = get('run-param-date');
    input.focus();
    // A month typed into a full-date parameter, as in the reported case.
    setValue(input, '2026-12');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(get('run-parameters-submit').disabled).toBe(true);
    dom.activeElement = null;
    input.dispatch('blur');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(get('run-param-date-error').textContent).toBe('Parameter date must be a valid date (YYYY-MM-DD)');
    expect(get('run-parameters-submit').disabled).toBe(true);
  });

  it('accepts a whole month in a date parameter with allow_month', () => {
    const { client, get, parse } = loadClient('admin');
    const job = parse({
      _id: 'job-4', name: 'Either', structured_execution: {
        environment_id: 'env-1', script_path: '/opt/etl/main.py', arguments: [],
        run_parameters: [{ name: 'date', flag: '--date', type: 'date', label: 'Date', style: 'equals', allow_month: true, min: '2026-11-10' }],
      },
    });
    client.openRunForm(job, { environment: null, runUrl: '/runjob', onStarted() {} });
    const input = get('run-param-date');
    expect(get('run-param-date-flag').textContent).toBe('runParameterArgument {"flag":"--date"} \u00b7 YYYY-MM-DD | YYYY-MM');
    setValue(input, '202611');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(get('run-parameters-submit').disabled).toBe(false);
    expect(JSON.parse(get('run-parameters-preview').textContent)).toEqual(['/opt/etl/main.py', '--date=2026-11']);

    // The calendar opens on the month of a month value and can select the whole month.
    input.pickerToggle.dispatch('click');
    const nodes = () => get('run-param-date-calendar').descendants();
    expect(nodes().find((node) => node.className === 'run-date-picker-title').textContent).toBe('November 2026');
    const whole = () => nodes().find((node) => node.getAttribute('data-month'));
    expect(whole().getAttribute('data-month')).toBe('2026-11');
    expect(whole().getAttribute('aria-pressed')).toBe('true');
    nodes().find((node) => node.getAttribute('data-date') === '2026-11-20').dispatch('click');
    expect(input.value).toBe('2026-11-20');

    input.pickerToggle.dispatch('click');
    nodes().find((node) => node.getAttribute('aria-label') === 'Previous month').dispatch('click');
    expect(whole().getAttribute('data-month')).toBe('2026-10');
    expect(whole().disabled).toBe(true);
    nodes().find((node) => node.getAttribute('aria-label') === 'Next month').dispatch('click');
    whole().dispatch('click');
    expect(input.value).toBe('2026-11');
  });

  it('opens the calendar on the current month and closes it with Escape', () => {
    const { client, get, job } = loadClient('admin');
    client.openRunForm(job, { environment: null, runUrl: '/runjob', onStarted() {} });
    const toggle = get('run-param-date').pickerToggle;
    toggle.dispatch('click');
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const panel = get('run-param-date-calendar');
    expect(panel.descendants().find((node) => node.getAttribute('data-date') === today).getAttribute('aria-current')).toBe('date');
    let stopped = false;
    panel.listeners.keydown[0]({ key: 'Escape', preventDefault() {}, stopPropagation() { stopped = true; } });
    expect(stopped).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('prefills a repeated run and keeps parameters absent from it switched off', () => {
    const { client, get, job, parse } = loadClient('admin');
    client.openRunForm(job, { environment: null, runUrl: '/runjob', onStarted() {}, initialValues: parse({ date: '2026-11-14' }) });
    expect(get('run-param-date').value).toBe('2026-11-14');
    expect(get('run-param-delete').checked).toBe(false);
    expect(JSON.parse(get('run-parameters-preview').textContent)).toEqual(['/opt/etl/main.py', '--verbose', '--date', '2026-11-14']);
  });
});

describe('Run parameters editor', () => {
  it('renders, adds, reorders and removes definitions, and reads them back', () => {
    const { client, get, job } = loadClient('admin');
    client.fillEditor(job.structured_execution.run_parameters);
    const cards = () => get('job-run-parameters').children;
    expect(cards()).toHaveLength(3);
    expect(get('run-parameter-2-options').value).toBe('full|Full');

    get('job-add-run-parameter').dispatch('click');
    expect(cards()).toHaveLength(4);
    setValue(get('run-parameter-3-flag'), '--batch');
    setValue(get('run-parameter-3-name'), 'batch');
    setValue(get('run-parameter-3-label'), 'Batch');
    setValue(get('run-parameter-3-type'), 'integer');
    expect(get('run-parameter-3-min').type).toBe('number');
    setValue(get('run-parameter-3-min'), '1');
    setValue(get('run-parameter-3-max'), '500');

    // Move the new parameter up, then remove the date parameter.
    const moveUp = cards()[3].children[0].children[1].children[0];
    moveUp.dispatch('click');
    const remove = cards()[0].children[0].children[1].children[2];
    remove.dispatch('click');

    const edited = client.readEditor();
    expect(edited.map((definition) => definition.name)).toEqual(['delete', 'batch', 'mode']);
    expect(edited[1]).toEqual({ name: 'batch', flag: '--batch', type: 'integer', label: 'Batch', min: 1, max: 500 });
    expect(edited[2]).toEqual({ name: 'mode', flag: '--mode', type: 'select', label: 'Mode', style: 'equals', options: [{ value: 'full', label: 'Full' }] });
  });

  it('suggests the technical name from the argument and keeps a name typed by hand', () => {
    const { client, get } = loadClient('admin');
    client.fillEditor([]);
    get('job-add-run-parameter').dispatch('click');
    setValue(get('run-parameter-0-flag'), '--Date-From');
    expect(get('run-parameter-0-name').value).toBe('date_from');
    setValue(get('run-parameter-0-name'), 'start');
    setValue(get('run-parameter-0-flag'), '--begin');
    expect(get('run-parameter-0-name').value).toBe('start');
    expect(client.readEditor()[0].name).toBe('start');
  });

  it('marks an invalid technical name and blocks the save before contacting the server', () => {
    const { client, get, dom } = loadClient('admin');
    client.fillEditor([]);
    get('job-add-run-parameter').dispatch('click');
    setValue(get('run-parameter-0-flag'), '--date');
    setValue(get('run-parameter-0-name'), 'Data');
    expect(get('run-parameter-0-name').getAttribute('aria-invalid')).toBe('true');
    expect(get('run-parameter-0-name-help').classList.contains('text-danger')).toBe(true);
    expect(get('run-parameter-0-name').getAttribute('aria-describedby')).toBe('run-parameter-0-name-help');
    expect(client.checkEditor()).toBe(false);
    expect(dom.activeElement).toBe(get('run-parameter-0-name'));

    setValue(get('run-parameter-0-name'), 'data');
    expect(get('run-parameter-0-name').getAttribute('aria-invalid')).toBeNull();
    expect(client.checkEditor()).toBe(true);
  });

  it('rejects an empty technical name on save', () => {
    const { client, get } = loadClient('admin');
    client.fillEditor([]);
    get('job-add-run-parameter').dispatch('click');
    expect(get('run-parameter-0-name').getAttribute('aria-invalid')).toBeNull();
    expect(client.checkEditor()).toBe(false);
    expect(get('run-parameter-0-name').getAttribute('aria-invalid')).toBe('true');
  });

  it('edits date limits and defaults as ISO text fields', () => {
    const { client, get } = loadClient('admin');
    client.fillEditor([{ name: 'date', flag: '--date', type: 'date', label: 'Date', min: '2026-01-01' }]);
    expect(get('run-parameter-0-min').type).toBe('text');
    expect(get('run-parameter-0-min').value).toBe('2026-01-01');
    setValue(get('run-parameter-0-max'), '20261231');
    setValue(get('run-parameter-0-default'), '2026-06-30');
    expect(get('run-parameter-0-max').value).toBe('2026-12-31');
    get('run-parameter-0-default').pickerToggle.dispatch('click');
    get('run-parameter-0-default-calendar').descendants().find((node) => node.getAttribute('data-date') === '2026-06-30').dispatch('click');
    expect(get('run-parameter-0-default').value).toBe('2026-06-30');
    expect(client.readEditor()[0]).toEqual({
      name: 'date', flag: '--date', type: 'date', label: 'Date', min: '2026-01-01', max: '2026-12-31', default: '2026-06-30',
    });
  });

  it('edits month limits and defaults as YYYY-MM', () => {
    const { client, get } = loadClient('admin');
    client.fillEditor([]);
    get('job-add-run-parameter').dispatch('click');
    setValue(get('run-parameter-0-flag'), '--date');
    setValue(get('run-parameter-0-label'), 'Period');
    setValue(get('run-parameter-0-type'), 'month');
    expect(get('run-parameter-0-min').placeholder).toBe('YYYY-MM');
    setValue(get('run-parameter-0-min'), '202501');
    setValue(get('run-parameter-0-default'), '202512');
    setValue(get('run-parameter-0-style'), 'equals');
    expect(client.readEditor()[0]).toEqual({
      name: 'date', flag: '--date', type: 'month', label: 'Period', style: 'equals', min: '2025-01', default: '2025-12',
    });
  });

  it('offers allow_month only on date parameters and saves it when checked', () => {
    const { client, get } = loadClient('admin');
    client.fillEditor([{ name: 'date', flag: '--date', type: 'date', label: 'Date' }]);
    setValue(get('run-parameter-0-allow-month'), true);
    expect(client.readEditor()[0]).toEqual({ name: 'date', flag: '--date', type: 'date', label: 'Date', allow_month: true });
    setValue(get('run-parameter-0-type'), 'month');
    expect(client.readEditor()[0]).not.toHaveProperty('allow_month');
    client.fillEditor([{ name: 'date', flag: '--date', type: 'date', label: 'Date', allow_month: true }]);
    expect(get('run-parameter-0-allow-month').checked).toBe(true);
  });

  it('disables adding parameters for the Ubuntu agent target', () => {
    const { client, get } = loadClient('admin');
    client.setEditorTarget('ubuntu-local');
    expect(get('job-add-run-parameter').disabled).toBe(true);
    expect(get('run-parameters-unsupported').classList.contains('d-none')).toBe(false);
    client.setEditorTarget('native-local');
    expect(get('job-add-run-parameter').disabled).toBe(false);
    expect(get('run-parameters-unsupported').classList.contains('d-none')).toBe(true);
  });
});
