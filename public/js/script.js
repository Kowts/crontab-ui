'use strict';

var crontabs = [];
var routes = {};
var i18n = {};

function tr(key, values) {
  var text = i18n[key] || key;
  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, function(_match, name) {
    return values && values[name] !== undefined ? String(values[name]) : '';
  });
}

function csrfToken() {
  var match = document.cookie.match(/(?:^|; )crontab_ui_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function initPage() {
  var jobs = document.getElementById('crontabs-state');
  var routeState = document.getElementById('routes-state');
  var env = document.getElementById('env-state');
  var i18nState = document.getElementById('i18n-state');
  if (i18nState) i18n = JSON.parse(i18nState.textContent);
  if (jobs) crontabs = JSON.parse(jobs.textContent);
  if (routeState) routes = JSON.parse(routeState.textContent);
  if (env) {
    var environmentValue = JSON.parse(env.textContent);
    $('#env_vars').val(environmentValue);
    renderEnvironment(environmentValue);
  }

  $.ajaxSetup({ headers: { 'X-CSRF-Token': csrfToken() } });
  try {
    var pendingRun = JSON.parse(sessionStorage.getItem('crontab_ui_manual_run') || 'null');
    if (pendingRun && pendingRun.jobId && pendingRun.operationId) trackManualRun(pendingRun.jobId, pendingRun.operationId);
  } catch (_error) { /* optional persistence */ }
  [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]')).forEach(function(el) {
    return new bootstrap.Tooltip(el);
  });
  if (document.getElementById('main_table')) {
    $('#main_table').DataTable({
      order: [[1, 'asc']], stateSave: true, stateDuration: 0,
      columns: [{ orderable: false }, null, null, null, { orderable: false }, { orderable: false }, { orderable: false }],
      language: {
        search: '', searchPlaceholder: tr('dataSearch'),
        lengthMenu: tr('dataPerPage'), info: tr('dataInfo'),
        infoEmpty: tr('dataInfoEmpty'), zeroRecords: tr('dataZero'), paginate: { first: '«', last: '»', next: '›', previous: '‹' }
      }
    });
  }
  var importInput = document.getElementById('import_file');
  var importForm = document.getElementById('import_form');
  if (importForm && importInput) importForm.addEventListener('submit', function(event) {
    event.preventDefault();
    if (!importInput.files.length) return;
    fetch(importForm.action, {
      method: 'POST', body: new FormData(document.getElementById('import_form')),
      headers: { 'X-CSRF-Token': csrfToken() }, credentials: 'same-origin'
    }).then(function(response) {
      if (response.ok) window.location.assign(response.url);
      else return response.json().catch(function() { return {}; }).then(function(body) {
        errorMessageBox(body.message || tr('importTitle'), body.operationId || response.headers.get('X-Request-ID'));
      });
    });
  });
}

document.addEventListener('DOMContentLoaded', initPage);

document.addEventListener('DOMContentLoaded', function() {
  var command = document.getElementById('job-command');
  if (command) command.addEventListener('input', function() {
    job_command = command.value;
    job_string();
  });
  document.querySelectorAll('[data-schedule]').forEach(function(button) {
    button.addEventListener('click', function() {
      schedule = button.dataset.schedule;
      job_string();
    });
  });
  var setScheduleButton = document.getElementById('set-schedule');
  if (setScheduleButton) setScheduleButton.addEventListener('click', set_schedule);
  document.querySelectorAll('.schedule-part').forEach(function(input) {
    input.addEventListener('focus', function() { input.select(); });
    input.addEventListener('input', function() {
      schedule = scheduleFromFields();
      job_string();
    });
  });
  var copyButton = document.getElementById('copy-crontab');
  if (copyButton) copyButton.addEventListener('click', copyCrontab);
  var languageSelect = document.getElementById('language-select');
  if (languageSelect) languageSelect.addEventListener('change', function() {
    $.post(routes.locale, { locale: languageSelect.value }).done(function() { window.location.reload(); });
  });
  var themeToggle = document.getElementById('theme-toggle');
  if (themeToggle && window.CrontabUITheme) {
    function updateThemeToggle(theme) {
      var dark = theme === 'dark';
      var label = tr(dark ? 'switchToLightTheme' : 'switchToDarkTheme');
      themeToggle.setAttribute('aria-pressed', String(dark));
      themeToggle.setAttribute('aria-label', label);
      themeToggle.setAttribute('title', label);
      var icon = document.getElementById('theme-toggle-icon');
      if (icon) icon.className = dark ? 'bi bi-sun' : 'bi bi-moon-stars';
    }
    updateThemeToggle(window.CrontabUITheme.current());
    themeToggle.addEventListener('click', function() {
      updateThemeToggle(window.CrontabUITheme.toggle());
    });
  }
  var environmentInput = document.getElementById('env_vars');
  if (environmentInput) environmentInput.addEventListener('input', function() { renderEnvironment(environmentInput.value); });
});

document.addEventListener('click', function(event) {
  var target = event.target.closest('[data-action]');
  if (!target) return;
  var id = target.dataset.id;
  switch (target.dataset.action) {
    case 'new-job': newJob(); break;
    case 'backup': doBackup(); break;
    case 'import-db': import_db(); break;
    case 'import-crontab': getCrontab(); break;
    case 'set-crontab': setCrontab(); break;
    case 'preview': previewCrontab(); break;
    case 'toggle-environment': toggleEnvironment(); break;
    case 'run': runJob(id); break;
    case 'edit': editJob(id); break;
    case 'stop': stopJob(id); break;
    case 'start': startJob(id); break;
    case 'duplicate': duplicateJob(id); break;
    case 'delete-job': deleteJob(id); break;
    case 'restore-backup': restore_backup(target.dataset.db); break;
    case 'delete-backup': delete_backup(target.dataset.db); break;
  }
});

/*********** MessageBox ****************/

function getModal(id) {
  return bootstrap.Modal.getOrCreateInstance(document.getElementById(id));
}

function infoMessageBox(message, title) {
  document.getElementById('info-body').textContent = message;
  document.getElementById('info-title').textContent = title;
  getModal('info-popup').show();
}

function errorMessageBox(message, operationId) {
  var details = tr('operationFailed', { message: message || tr('error') });
  if (operationId) details += ' ' + tr('auditOperationId', { operationId: operationId });
  infoMessageBox(details, tr('error'));
}

function handleOperationFailure(response) {
  var body = response && response.responseJSON ? response.responseJSON : {};
  var operationId = body.operationId || (response && response.getResponseHeader && response.getResponseHeader('X-Request-ID'));
  errorMessageBox(body.message || (response && response.statusText) || tr('error'), operationId);
}

function messageBox(body, title, ok_text, close_text, callback) {
  var modalBody = document.getElementById('modal-body');
  if (typeof body === 'string') {
    modalBody.innerHTML = body;
  } else {
    modalBody.innerHTML = '';
    modalBody.appendChild(body);
  }
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-button').textContent = ok_text || tr('actions');
  document.getElementById('modal-close-button').textContent = close_text || tr('cancel');

  var btn = document.getElementById('modal-button');
  var newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);
  newBtn.addEventListener('click', function() {
    getModal('popup').hide();
    if (callback) callback();
  });

  getModal('popup').show();
}


/*********** crontab actions ****************/

var schedule = '';
var job_command = '';

function deleteJob(_id) {
  messageBox('<p>' + tr('deleteTaskBody') + '</p>', tr('deleteTaskTitle'), tr('delete'), tr('cancel'), function() {
    $.post(routes.remove, {_id: _id}, function() {
      location.reload();
    }).fail(handleOperationFailure);
  });
}

function stopJob(_id) {
  messageBox('<p>' + tr('pauseTaskBody') + '</p>', tr('pauseTaskTitle'), tr('pause'), tr('cancel'), function() {
    $.post(routes.stop, {_id: _id}, function(result) {
      updateJobStatus(result.id, result.stopped);
    }).fail(handleOperationFailure);
  });
}

function startJob(_id) {
  messageBox('<p>' + tr('activateTaskBody') + '</p>', tr('activateTaskTitle'), tr('activate'), tr('cancel'), function() {
    $.post(routes.start, {_id: _id}, function(result) {
      updateJobStatus(result.id, result.stopped);
    }).fail(handleOperationFailure);
  });
}

function runJob(_id) {
  messageBox('<p>' + tr('runTaskBody') + '</p>', tr('runTaskTitle'), tr('run'), tr('cancel'), function() {
    $.post(routes.run, {_id: _id}, function(result) {
      trackManualRun(_id, result.operationId);
    }).fail(handleOperationFailure);
  });
}

function updateJobStatus(_id, stopped) {
  crontabs.forEach(function(job) { if (job._id === _id) job.stopped = stopped; });
  var row = document.querySelector('[data-job-row][data-id="' + _id + '"]');
  if (!row) return;
  row.classList.toggle('table-light', stopped);
  var button = row.querySelector('[data-toggle-job]');
  if (!button) return;
  button.dataset.action = stopped ? 'start' : 'stop';
  button.innerHTML = stopped
    ? '<i class="bi bi-play-fill"></i><span class="visually-hidden">' + tr('activate') + '</span>'
    : '<i class="bi bi-pause-fill"></i><span class="visually-hidden">' + tr('pause') + '</span>';
}

function trackManualRun(jobId, operationId) {
  var button = document.querySelector('[data-action="run"][data-id="' + jobId + '"]');
  if (button) { button.disabled = true; button.innerHTML = '<span class="spinner-border spinner-border-sm" aria-hidden="true"></span><span class="visually-hidden">' + tr('run') + '</span>'; }
  var cancelButton = null;
  if (button && button.parentNode) {
    cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'btn btn-sm btn-outline-danger ms-1';
    cancelButton.innerHTML = '<i class="bi bi-stop-fill" aria-hidden="true"></i><span class="visually-hidden">' + tr('cancel') + '</span>';
    cancelButton.addEventListener('click', function() {
      cancelButton.disabled = true;
      $.post(routes.cancel_run, { operationId: operationId }).fail(function(response) {
        cancelButton.disabled = false;
        handleOperationFailure(response);
      });
    });
    button.after(cancelButton);
  }
  try { sessionStorage.setItem('crontab_ui_manual_run', JSON.stringify({ jobId: jobId, operationId: operationId })); } catch (_error) { /* optional persistence */ }
  var poll = function() {
    $.get(routes.run_status, { operationId: operationId }).done(function(run) {
      if (run.status === 'running') return setTimeout(poll, 1500);
      if (button) { button.disabled = false; button.innerHTML = '<i class="bi bi-play-fill"></i><span class="visually-hidden">' + tr('run') + '</span>'; }
      if (cancelButton) cancelButton.remove();
      try { sessionStorage.removeItem('crontab_ui_manual_run'); } catch (_error) { /* optional persistence */ }
      infoMessageBox(tr('runSuccess', { auditOperationId: tr('auditOperationId', { operationId: operationId }) }), tr('runComplete'));
    }).fail(function(response) { if (button) button.disabled = false; if (cancelButton) cancelButton.remove(); handleOperationFailure(response); });
  };
  poll();
}

function setCrontab() {
  messageBox('<p>' + tr('publishBody') + '</p>', tr('publishTitle'), tr('publishToCrontab'), tr('cancel'), function() {
    $.post(routes.crontab, { env_vars: $('#env_vars').val() }, function() {
      infoMessageBox(tr('publishSuccess'), tr('publicationComplete'));
      location.reload();
    }).fail(handleOperationFailure);
  });
}

function getCrontab() {
  messageBox(
    '<p>' + tr('getBody') + '</p>', tr('getTitle'), tr('import'), tr('cancel'), function() {
    $.post(routes.import_crontab, {}, function() {
        infoMessageBox(tr('importSuccess'), tr('importComplete'));
        location.reload();
      }).fail(handleOperationFailure);
    });
}

function editJob(_id) {
  var job = null;
  crontabs.forEach(function(crontab) {
    if (crontab._id === _id) job = crontab;
  });

  if (job) {
    document.getElementById('job-title').textContent = tr('edit') + ' ' + tr('tasks').toLowerCase().replace(/s$/, '');
    getModal('job').show();
    $('#job-name').val(job.name);
    $('#job-command').val(job.command);
    if (job.schedule.indexOf('@') !== 0) {
      var components = job.schedule.split(' ');
      $('#job-minute').val(components[0]);
      $('#job-hour').val(components[1]);
      $('#job-day').val(components[2]);
      $('#job-month').val(components[3]);
      $('#job-week').val(components[4]);
    }
    schedule = job.schedule;
    job_command = job.command;
    if (job.logging && job.logging !== 'false')
      $('#job-logging').prop('checked', true);
    job_string();
  }

  var saveBtn = document.getElementById('job-save');
  var newSaveBtn = saveBtn.cloneNode(true);
  saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
  newSaveBtn.addEventListener('click', function() {
    if (!schedule) schedule = '* * * * *';
    var name = $('#job-name').val();
    var mailing = job.mailing && job.mailing.profileId ? { profileId: job.mailing.profileId } : {};
    var logging = $('#job-logging').prop('checked');
    $.post(routes.save, {name: name, command: collapsedCommand(), schedule: schedule, _id: _id, logging: logging, mailing: mailing}, function() {
      location.reload();
    }).fail(handleOperationFailure);
    getModal('job').hide();
  });
}

function newJob() {
  schedule = '';
  job_command = '';
  $('#job-minute').val('*');
  $('#job-hour').val('*');
  $('#job-day').val('*');
  $('#job-month').val('*');
  $('#job-week').val('*');

  document.getElementById('job-title').textContent = tr('newTask');
  getModal('job').show();
  $('#job-name').val('');
  $('#job-command').val('');
  $('#job-logging').prop('checked', false);
  job_string();

  var saveBtn = document.getElementById('job-save');
  var newSaveBtn = saveBtn.cloneNode(true);
  saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
  newSaveBtn.addEventListener('click', function() {
    if (!schedule) schedule = '* * * * *';
    var name = $('#job-name').val();
    var mailing = {};
    var logging = $('#job-logging').prop('checked');
    $.post(routes.save, {name: name, command: collapsedCommand(), schedule: schedule, _id: -1, logging: logging, mailing: mailing}, function() {
      location.reload();
    }).fail(handleOperationFailure);
    getModal('job').hide();
  });
}

function duplicateJob(_id) {
  var job = null;
  crontabs.forEach(function(crontab) {
    if (crontab._id === _id) job = crontab;
  });
  if (!job) return;

  var name = job.name ? job.name + ' (copy)' : '';
  var logging = (job.logging && job.logging !== 'false') ? job.logging : 'false';
  var mailing = job.mailing || {};

  $.post(routes.save, {
    name: name,
    command: job.command,
    schedule: job.schedule,
    _id: -1,
    logging: logging,
    mailing: mailing
  }, function() {
    location.reload();
  }).fail(handleOperationFailure);
}

function doBackup() {
  messageBox(
    '<div class="backup-notice"><strong>' + tr('backupNoticeTitle') + '</strong>' + tr('backupNotice') + '</div><ul class="backup-list"><li>' + tr('backupDoesNotChange') + '</li><li>' + tr('backupRestoreHint') + '</li></ul>',
    tr('createBackup'), tr('createBackup'), tr('cancel'), function() {
    $.post(routes.backup, {}, function() {
      location.reload();
    }).fail(handleOperationFailure);
  });
}

function delete_backup(db_name) {
  messageBox('<p>' + tr('deleteBackupBody') + '</p>', tr('deleteBackupTitle'), tr('delete'), tr('cancel'), function() {
    $.post(routes.delete_backup, { db: db_name }, function() {
      location = routes.root;
    }).fail(handleOperationFailure);
  });
}

function restore_backup(db_name) {
  messageBox('<p>' + tr('restoreBackupBody') + '</p>', tr('restoreBackupTitle'), tr('restoreBackup'), tr('cancel'), function() {
    $.post(routes.restore_backup, { db: db_name }, function() {
      location = routes.root;
    }).fail(handleOperationFailure);
  });
}

function import_db() {
  getModal('import-modal').show();
}


function collapsedCommand() {
  return job_command.split(/\r?\n/).map(function(l) { return l.trim(); }).filter(Boolean).join('; ');
}

function job_string() {
  var cmd = collapsedCommand();
  var preview = document.getElementById('job-string');
  if (preview) preview.textContent = (schedule + ' ' + cmd).trim() || '* * * * *';
  updateScheduleDescription(schedule || scheduleFromFields());
  return schedule + ' ' + cmd;
}

function scheduleFromFields() {
  return [
    $('#job-minute').val(),
    $('#job-hour').val(),
    $('#job-day').val(),
    $('#job-month').val(),
    $('#job-week').val()
  ].map(function(part) { return String(part || '').trim() || '*'; }).join(' ');
}

function updateScheduleDescription(value) {
  var description = document.getElementById('job-schedule-description');
  if (description) description.textContent = describeSchedule(value);
}

function describeSchedule(value) {
  if (!window.cronstrue) {
    return tr('cronLoadFailure');
  }
  try {
    return window.cronstrue.toString(value, {
      locale: i18n.scheduledTasks === 'Tarefas agendadas' ? 'pt_PT' : 'en',
      use24HourTimeFormat: true,
      verbose: true,
      throwExceptionOnParseError: true
    });
  } catch (error) {
    return cronDescriptionError(error);
  }
}

function cronDescriptionError(error) {
  var technicalMessage = String(error);
  var messages = [
    [/minutes part/i, tr('cronMinuteInvalid')],
    [/hours part/i, tr('cronHourInvalid')],
    [/DOM part/i, tr('cronDayInvalid')],
    [/month part/i, tr('cronMonthInvalid')],
    [/DOW part/i, tr('cronWeekInvalid')]
  ];
  for (var index = 0; index < messages.length; index += 1) {
    if (messages[index][0].test(technicalMessage)) return messages[index][1];
  }
  return tr('cronInvalid');
}

function toggleEnvironment() {
  var editor = document.getElementById('environment-editor');
  var display = document.getElementById('environment-display');
  var toggle = document.getElementById('environment-toggle');
  if (!editor || !display) return;
  var editing = editor.classList.contains('d-none');
  editor.classList.toggle('d-none', !editing);
  display.parentElement.classList.toggle('d-none', editing);
  if (toggle) toggle.textContent = editing ? tr('done') : tr('edit');
}

function renderEnvironment(value) {
  var display = document.getElementById('environment-display');
  if (display) display.textContent = String(value || '').trim() || tr('environmentEmpty');
}

function set_schedule() {
  schedule = scheduleFromFields();
  job_string();
}

function previewCrontab() {
  $.get(routes.preview_crontab, function(data) {
    document.getElementById('preview-crontab-content').textContent = data || '# (empty crontab)';
    getModal('preview-crontab-modal').show();
  });
}

function copyCrontab() {
  var text = document.getElementById('preview-crontab-content').textContent;
  navigator.clipboard.writeText(text).then(function() {
    var btn = document.querySelector('#preview-crontab-modal .btn-outline-secondary');
    btn.innerHTML = '<i class="bi bi-check2"></i> Copiado';
    setTimeout(function() {
      btn.innerHTML = '<i class="bi bi-clipboard"></i> Copiar';
    }, 2000);
  });
}
