'use strict';

/* global describe, it, expect */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { dictionaries } = require('../config/i18n');

function createPanel(locale = 'en', confirm = true) {
  function element(tag = 'div') {
    return {
      tag, children: [], attributes: {}, listeners: {}, value: '', textContent: '', selectedOptions: [],
      appendChild(child) { this.children.push(child); return child; },
      append(...children) { this.children.push(...children); },
      replaceChildren() { this.children = []; },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      querySelectorAll() { return []; },
    };
  }
  const nodes = {};
  const get = (id) => (nodes[id] ||= element());
  const targets = [{ id: 'native-local', code: 'native-local', health_status: 'unknown' }];
  const items = ['pending', 'valid', 'invalid', 'unavailable'].map((status, index) => ({
    id: `env-${index}`, name: `Python ${index}`, code: `python-${index}`,
    runtime_type: 'python', target_id: 'native-local', executable_path: '/opt/etl/main-env/bin/python',
    default_working_directory: index ? null : '/opt/etl', enabled: index !== 3,
    validation_status: status, revision: 3, dependent_task_count: index,
  }));
  get('routes-state').textContent = JSON.stringify({
    execution_targets: '/base/api/execution-targets', execution_environments: '/base/api/execution-environments',
  });
  get('i18n-state').textContent = JSON.stringify(dictionaries[locale]);
  function resolved(result) {
    return {
      then(callback) { return resolved(callback(result)); },
      catch() { return this; },
      done(callback) { callback(result); return this; },
      fail() { return this; },
      always(callback) { callback(); return this; },
    };
  }
  const requests = [];
  let modalShown = false;
  const jquery = {
    ajaxSetup() {},
    ajax(options) {
      requests.push(options);
      if (options.method === 'POST') return resolved({});
      if (options.url.endsWith('/tasks')) return resolved([]);
      return resolved(options.url.endsWith('execution-targets') ? targets : { items, total: items.length });
    },
  };
  function Dropdown() {}
  Dropdown.getInstance = () => null;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'execution-environments.js'), 'utf8'), {
    document: { cookie: '', getElementById: get, createElement: element, querySelectorAll: () => [] },
    bootstrap: { Modal: { getOrCreateInstance: () => ({ show() { modalShown = true; } }) }, Dropdown },
    $: jquery, URLSearchParams, window: { confirm: () => confirm },
  });
  const descendants = (node) => [node, ...node.children.flatMap(descendants)];
  return { get, items, requests, descendants, modalShown: () => modalShown, dictionary: dictionaries[locale] };
}

describe('Execution environments panel', () => {
  it.each(['en', 'pt'])('shows expandable paths, labelled states and secondary actions in %s', (locale) => {
    const { get, items, descendants, dictionary } = createPanel(locale);
    const rows = get('execution-environments-body').children;
    rows.forEach((row, index) => {
      const details = row.children[3].children[0];
      expect(details.tag).toBe('details');
      expect(details.children[0].textContent).toBe(dictionary.environmentViewDetails);
      expect(details.children[0].attributes['aria-label']).toBe(`${dictionary.executablePath}: ${items[index].name}`);
      expect(details.children[1].children[1].children[0].textContent).toBe(items[index].executable_path);
      expect(details.children[1].children[3].children[0].textContent).toBe(index ? dictionary.none : '/opt/etl');
      expect(row.children[4].children[0].className).toContain(`environment-state-${items[index].validation_status}`);
      expect(row.children[6].children[0].textContent).toBe(index === 3 ? dictionary.environmentDisabled : dictionary.environmentEnabled);
      const actions = descendants(row.children[7]);
      expect(actions.find((node) => node.attributes['data-bs-toggle'] === 'dropdown').attributes['aria-label'])
        .toBe(`${dictionary.actions}: ${items[index].name}`);
      const menu = actions.find((node) => node.className === 'dropdown-menu dropdown-menu-end');
      expect(menu.children[0].textContent).toBe(index === 3 ? dictionary.environmentEnableAction : dictionary.environmentDisableAction);
    });
  });

  it('keeps editing and dependency review in the existing modal', () => {
    const panel = createPanel();
    const first = panel.get('execution-environments-body').children[0];
    panel.descendants(first).find((node) => node.tag === 'button' && node.textContent === panel.dictionary.edit).listeners.click();
    expect(panel.modalShown()).toBe(true);
    expect(panel.get('environment-executable').value).toBe(panel.items[0].executable_path);
    expect(panel.requests.at(-1).url).toBe('/base/api/execution-environments/env-0/tasks');
  });

  it.each([true, false])('preserves confirmation and optimistic revision when toggling (%s)', (confirmation) => {
    const panel = createPanel('en', confirmation);
    for (const index of [0, 3]) {
      const row = panel.get('execution-environments-body').children[index];
      panel.descendants(row).find((node) => node.className === 'dropdown-item').listeners.click();
    }
    const posts = panel.requests.filter((request) => request.method === 'POST');
    expect(posts).toHaveLength(confirmation ? 2 : 0);
    if (confirmation) {
      expect(posts.map((request) => request.url)).toEqual([
        '/base/api/execution-environments/env-0/disable', '/base/api/execution-environments/env-3/enable',
      ]);
      posts.forEach((request) => expect(JSON.parse(request.data)).toEqual({ revision: 3 }));
    }
  });

  it('keeps destination, runtime and state filters on the configured API prefix', () => {
    const { get, requests } = createPanel();
    get('environment-target-filter').value = 'native-local';
    get('environment-runtime-filter').value = 'python';
    get('environment-enabled-filter').value = 'false';
    get('environment-enabled-filter').listeners.change();
    const url = new URL(requests.at(-1).url, 'http://localhost');
    expect(url.pathname).toBe('/base/api/execution-environments');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      target_id: 'native-local', runtime_type: 'python', enabled: 'false',
    });
  });
});
