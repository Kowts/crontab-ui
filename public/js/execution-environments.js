'use strict';

(function() {
  var routes = JSON.parse(document.getElementById('routes-state').textContent);
  var i18n = JSON.parse(document.getElementById('i18n-state').textContent);
  var pageSize = 50;
  var offset = 0;
  var total = 0;
  var targets = [];
  var environments = [];
  var currentEnvironment = null;
  var currentTab = 'general';
  var modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('execution-environment-modal'));

  function tr(key) {
    return i18n[key] || key;
  }

  function csrfToken() {
    var match = document.cookie.match(/(?:^|; )crontab_ui_csrf=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  $.ajaxSetup({ headers: { 'X-CSRF-Token': csrfToken() } });

  function api(url, method, payload) {
    return $.ajax({
      url: url,
      method: method || 'GET',
      contentType: 'application/json',
      data: payload === undefined ? undefined : JSON.stringify(payload),
    });
  }

  function addOption(select, value, label) {
    var option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }

  function loadTargets() {
    return api(routes.execution_targets).then(function(items) {
      targets = items;
      var targetFilter = document.getElementById('environment-target-filter');
      var targetSelect = document.getElementById('environment-target');
      targets.forEach(function(target) {
        var state = target.health_status === 'unavailable' ? tr('statusUnavailable') : tr('statusPending');
        var label = target.name + ' (' + state + ')';
        addOption(targetFilter, target.id, target.name);
        addOption(targetSelect, target.id, label);
      });
    });
  }

  function statusLabel(status) {
    return tr({ pending: 'statusPending', valid: 'statusValid', invalid: 'statusInvalid', unavailable: 'statusUnavailable' }[status] || 'statusUnavailable');
  }

  function runtimeLabel(runtime) {
    return tr({ python: 'runtimePython', node: 'runtimeNode', bash: 'runtimeBash', binary: 'runtimeBinary' }[runtime] || 'runtimeBinary');
  }

  function targetLabel(environment) {
    return environment.target ? environment.target.name : environment.target_id;
  }

  function addCell(row, value, className) {
    var cell = document.createElement('td');
    if (className) cell.className = className;
    cell.textContent = value;
    row.appendChild(cell);
    return cell;
  }

  function renderRows() {
    var body = document.getElementById('execution-environments-body');
    var empty = document.getElementById('environment-empty');
    body.replaceChildren();
    empty.hidden = environments.length !== 0;

    environments.forEach(function(environment) {
      var row = document.createElement('tr');
      var nameCell = addCell(row, '');
      var name = document.createElement('strong');
      name.textContent = environment.name;
      nameCell.appendChild(name);
      var code = document.createElement('small');
      code.className = 'd-block text-muted';
      code.textContent = environment.code;
      nameCell.appendChild(code);
      addCell(row, runtimeLabel(environment.runtime_type));
      addCell(row, targetLabel(environment));
      var pathCell = addCell(row, environment.executable_path, 'text-truncate');
      pathCell.title = environment.executable_path;
      pathCell.style.maxWidth = '20rem';
      var validationCell = addCell(row, statusLabel(environment.validation_status));
      validationCell.setAttribute('data-validation-status', environment.validation_status);
      addCell(row, String(environment.dependent_task_count || 0));
      addCell(row, environment.enabled ? tr('environmentEnabled') : tr('environmentDisabled'));

      var actions = document.createElement('td');
      actions.className = 'text-end text-nowrap';
      var edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn btn-sm btn-outline-secondary me-1';
      edit.textContent = tr('edit');
      edit.setAttribute('aria-label', tr('edit') + ' ' + environment.name);
      edit.addEventListener('click', function() { openEnvironment(environment); });
      actions.appendChild(edit);
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'btn btn-sm btn-outline-secondary';
      toggle.textContent = environment.enabled ? tr('environmentDisabled') : tr('environmentEnabled');
      toggle.addEventListener('click', function() { toggleEnvironment(environment); });
      actions.appendChild(toggle);
      row.appendChild(actions);
      body.appendChild(row);
    });

    var first = total ? offset + 1 : 0;
    var last = offset + environments.length;
    document.getElementById('environment-page-status').textContent = first + '–' + last + ' / ' + total;
    document.getElementById('environment-page-prev').disabled = offset === 0;
    document.getElementById('environment-page-next').disabled = last >= total;
  }

  function loadEnvironments() {
    var status = document.getElementById('environment-list-status');
    status.textContent = '';
    var query = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
    var target = document.getElementById('environment-target-filter').value;
    var runtime = document.getElementById('environment-runtime-filter').value;
    var enabled = document.getElementById('environment-enabled-filter').value;
    if (target) query.set('target_id', target);
    if (runtime) query.set('runtime_type', runtime);
    if (enabled) query.set('enabled', enabled);
    return api(routes.execution_environments + '?' + query.toString()).then(function(result) {
      environments = result.items;
      total = result.total;
      renderRows();
    }).catch(function() {
      status.textContent = tr('environmentLoadError');
      environments = [];
      total = 0;
      renderRows();
    });
  }

  function fillForm(environment) {
    currentEnvironment = environment || null;
    document.getElementById('environment-modal-title').textContent = environment ? tr('edit') + ' ' + environment.name : tr('addExecutionEnvironment');
    document.getElementById('environment-name').value = environment ? environment.name : '';
    document.getElementById('environment-code').value = environment ? environment.code : '';
    document.getElementById('environment-code').disabled = Boolean(environment);
    document.getElementById('environment-runtime').value = environment ? environment.runtime_type : 'python';
    document.getElementById('environment-description').value = environment ? (environment.description || '') : '';
    document.getElementById('environment-enabled').checked = environment ? environment.enabled : true;
    document.getElementById('environment-enabled').disabled = Boolean(environment);
    document.getElementById('environment-target').value = environment ? environment.target_id : (targets[0] ? targets[0].id : '');
    document.getElementById('environment-executable').value = environment ? environment.executable_path : '';
    document.getElementById('environment-working-directory').value = environment ? (environment.default_working_directory || '') : '';
    document.getElementById('environment-validation-result').textContent = environment ? statusLabel(environment.validation_status) : '';
    document.getElementById('environment-form-error').hidden = true;
    document.getElementById('environment-validate').disabled = !environment;
    setTab('general');
  }

  function openEnvironment(environment) {
    fillForm(environment);
    modal.show();
    if (environment) loadDependencies(environment.id);
    else renderReview([]);
  }

  function setTab(tab) {
    currentTab = tab;
    document.querySelectorAll('[data-environment-tab]').forEach(function(button) {
      var selected = button.dataset.environmentTab === tab;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
    });
    document.querySelectorAll('[data-environment-panel]').forEach(function(panel) {
      panel.hidden = panel.dataset.environmentPanel !== tab;
    });
    document.getElementById('environment-tab-back').hidden = tab === 'general';
    document.getElementById('environment-tab-next').hidden = tab === 'review';
    document.getElementById('environment-save').hidden = tab !== 'review';
  }

  function formIsValid(tab) {
    var ids = tab === 'general'
      ? ['environment-name', 'environment-code']
      : ['environment-target', 'environment-executable'];
    for (var index = 0; index < ids.length; index += 1) {
      var input = document.getElementById(ids[index]);
      if (!input.checkValidity()) {
        input.reportValidity();
        input.focus();
        return false;
      }
    }
    return true;
  }

  function renderReview(tasks) {
    var summary = document.getElementById('environment-review-summary');
    summary.replaceChildren();
    [
      [tr('name'), document.getElementById('environment-name').value],
      [tr('environmentCode'), document.getElementById('environment-code').value],
      [tr('environmentRuntime'), runtimeLabel(document.getElementById('environment-runtime').value)],
      [tr('executionTarget'), document.getElementById('environment-target').selectedOptions[0]?.textContent || ''],
      [tr('executablePath'), document.getElementById('environment-executable').value],
      [tr('workingDirectory'), document.getElementById('environment-working-directory').value],
    ].forEach(function(pair) {
      var term = document.createElement('dt');
      term.className = 'col-sm-4';
      term.textContent = pair[0];
      var value = document.createElement('dd');
      value.className = 'col-sm-8 text-break';
      value.textContent = pair[1] || '—';
      summary.append(term, value);
    });
    document.getElementById('environment-task-count').textContent = String(tasks.length);
    var list = document.getElementById('environment-task-list');
    list.replaceChildren();
    tasks.forEach(function(task) {
      var item = document.createElement('li');
      item.className = 'list-group-item d-flex justify-content-between gap-3';
      item.textContent = task.name || task.id;
      var schedule = document.createElement('code');
      schedule.textContent = task.schedule;
      item.appendChild(schedule);
      list.appendChild(item);
    });
    if (!tasks.length) {
      var empty = document.createElement('li');
      empty.className = 'list-group-item text-muted';
      empty.textContent = tr('none');
      list.appendChild(empty);
    }
  }

  function loadDependencies(id) {
    return api(routes.execution_environments + '/' + encodeURIComponent(id) + '/tasks')
      .then(renderReview).catch(function() { renderReview([]); });
  }

  function saveEnvironment() {
    var error = document.getElementById('environment-form-error');
    error.hidden = true;
    var payload = {
      name: document.getElementById('environment-name').value,
      runtime_type: document.getElementById('environment-runtime').value,
      target_id: document.getElementById('environment-target').value,
      executable_path: document.getElementById('environment-executable').value,
      default_working_directory: document.getElementById('environment-working-directory').value || null,
      description: document.getElementById('environment-description').value,
    };
    var url = routes.execution_environments;
    var method = 'POST';
    if (currentEnvironment) {
      payload.revision = currentEnvironment.revision;
      method = 'PATCH';
      url += '/' + encodeURIComponent(currentEnvironment.id);
    } else {
      payload.code = document.getElementById('environment-code').value;
      payload.enabled = document.getElementById('environment-enabled').checked;
    }
    var button = document.getElementById('environment-save');
    button.disabled = true;
    api(url, method, payload).done(function() {
      modal.hide();
      loadEnvironments();
    }).fail(function(response) {
      error.textContent = response.responseJSON?.message || tr('environmentFormError');
      error.hidden = false;
    }).always(function() { button.disabled = false; });
  }

  function toggleEnvironment(environment) {
    var enabling = !environment.enabled;
    var confirmation = enabling ? tr('environmentEnableConfirm') : tr('environmentDisableConfirm');
    if (!window.confirm(confirmation)) return;
    api(routes.execution_environments + '/' + encodeURIComponent(environment.id) + '/' + (enabling ? 'enable' : 'disable'), 'POST', {
      revision: environment.revision,
    }).done(loadEnvironments).fail(function() {
      document.getElementById('environment-list-status').textContent = tr('environmentFormError');
    });
  }

  function validateEnvironment() {
    if (!currentEnvironment) return;
    var result = document.getElementById('environment-validation-result');
    var button = document.getElementById('environment-validate');
    button.disabled = true;
    result.textContent = tr('loading');
    api(routes.execution_environments + '/' + encodeURIComponent(currentEnvironment.id) + '/validate', 'POST', {})
      .done(function(response) { result.textContent = statusLabel(response.validation_status); })
      .fail(function(response) {
        result.textContent = statusLabel(response.responseJSON?.validation_status || 'unavailable');
        loadEnvironments();
      })
      .always(function() { button.disabled = false; });
  }

  document.getElementById('environment-add').addEventListener('click', function() { openEnvironment(null); });
  document.getElementById('environment-save').addEventListener('click', saveEnvironment);
  document.getElementById('environment-validate').addEventListener('click', validateEnvironment);
  document.getElementById('environment-tab-next').addEventListener('click', function() {
    if (!formIsValid(currentTab)) return;
    if (currentTab === 'general') return setTab('execution');
    if (currentTab === 'execution') {
      if (currentEnvironment) loadDependencies(currentEnvironment.id);
      else renderReview([]);
      return setTab('review');
    }
  });
  document.getElementById('environment-tab-back').addEventListener('click', function() {
    setTab(currentTab === 'review' ? 'execution' : 'general');
  });
  document.querySelectorAll('[data-environment-tab]').forEach(function(button) {
    button.addEventListener('click', function() {
      if (button.dataset.environmentTab === 'review' && !formIsValid('execution')) return;
      setTab(button.dataset.environmentTab);
    });
  });
  ['environment-target-filter', 'environment-runtime-filter', 'environment-enabled-filter'].forEach(function(id) {
    document.getElementById(id).addEventListener('change', function() { offset = 0; loadEnvironments(); });
  });
  document.getElementById('environment-page-prev').addEventListener('click', function() {
    offset = Math.max(0, offset - pageSize);
    loadEnvironments();
  });
  document.getElementById('environment-page-next').addEventListener('click', function() {
    if (offset + pageSize < total) { offset += pageSize; loadEnvironments(); }
  });

  loadTargets().then(loadEnvironments).catch(function() {
    document.getElementById('environment-list-status').textContent = tr('environmentLoadError');
  });
})();
