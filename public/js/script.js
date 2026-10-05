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

function closeImportModal(callback) {
  var modalElement = document.getElementById('import-modal');
  if (!modalElement || !modalElement.classList.contains('show')) return callback();
  modalElement.addEventListener('hidden.bs.modal', callback, { once: true });
  getModal('import-modal').hide();
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
    function updatePagingVisibility(api) {
      var pager = api.table().container().querySelector('.dt-paging');
      if (pager) pager.classList.toggle('d-none', api.page.info().pages <= 1);
    }
    $('#main_table').DataTable({
      order: [[1, 'asc']], stateSave: true, stateDuration: 0,
      columns: [{ orderable: false }, null, { visible: false }, null, { orderable: false }, { orderable: false }, { orderable: false }, { orderable: false }],
      drawCallback: function() { updatePagingVisibility(this.api()); },
      language: {
        search: '', searchPlaceholder: tr('dataSearch'),
        lengthMenu: tr('dataPerPage'), info: tr('dataInfo'),
        infoEmpty: tr('dataInfoEmpty'), zeroRecords: tr('dataZero'), paginate: { first: '«', last: '»', next: '›', previous: '‹' }
      }
    });
  }
  var importInput = document.getElementById('import_file');
  var importForm = document.getElementById('import_form');
  var importMode = document.getElementById('import_mode');
  var importConfirm = document.getElementById('import-confirm');
  var importPreviewSummary = document.getElementById('import-preview-summary');
  function updateImportModeHint() {
    var hint = document.getElementById('import-mode-help');
    if (hint && importMode) hint.textContent = tr(importMode.value === 'replace' ? 'importReplaceHint' : 'importMergeHint');
  }
  function renderImportPreview(summary) {
    if (!importPreviewSummary) return;
    importPreviewSummary.replaceChildren();
    var values = [
      ['existingTasks', summary.existing], ['incomingTasks', summary.incoming],
      ['importAdditions', summary.added], ['importDuplicates', summary.skipped],
      ['importConflicts', summary.conflicts],
    ];
    if (summary.mode === 'replace') values.push(['importReplaced', summary.replaced]);
    values.forEach(function(item) {
      var term = document.createElement('dt');
      term.className = 'col-8';
      term.textContent = tr(item[0]);
      var value = document.createElement('dd');
      value.className = 'col-4 text-end';
      value.textContent = String(item[1]);
      importPreviewSummary.append(term, value);
    });
    if (importConfirm) importConfirm.textContent = tr(summary.mode === 'replace' ? 'importConfirmReplace' : 'importConfirmMerge');
  }
  function importRequest(preview) {
    var action = new URL(importForm.getAttribute('action'), window.location.origin);
    var payload = new FormData(importForm);
    payload.set('dryRun', preview ? 'true' : 'false');
    return fetch(action.pathname + action.search, {
      method: 'POST', body: payload,
      headers: { 'X-CSRF-Token': csrfToken() }, credentials: 'same-origin'
    }).then(function(response) {
      return response.json().catch(function() { return {}; }).then(function(body) {
        if (!response.ok) {
          var error = new Error(body.message || tr('importTitle'));
          error.operationId = body.operationId || response.headers.get('X-Request-ID');
          throw error;
        }
        return body;
      });
    });
  }
  if (importMode) {
    importMode.addEventListener('change', updateImportModeHint);
    updateImportModeHint();
  }
  if (importForm && importInput) importForm.addEventListener('submit', function(event) {
    event.preventDefault();
    if (!importInput.files.length) return;
    var submitButton = event.submitter;
    if (submitButton) submitButton.disabled = true;
    importRequest(true).then(function(summary) {
      renderImportPreview(summary);
      closeImportModal(function() { getModal('import-preview-modal').show(); });
    }).catch(function(error) {
      closeImportModal(function() { errorMessageBox(error.message, error.operationId); });
    }).finally(function() {
      if (submitButton) submitButton.disabled = false;
    });
  });
  if (importConfirm) importConfirm.addEventListener('click', function() {
    importConfirm.disabled = true;
    importRequest(false).then(function() {
      getModal('import-preview-modal').hide();
      window.location.reload();
    }).catch(function(error) {
      getModal('import-preview-modal').hide();
      errorMessageBox(error.message, error.operationId);
    }).finally(function() {
      importConfirm.disabled = false;
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
  var mailProfile = document.getElementById('job-mail-profile');
  if (mailProfile) mailProfile.addEventListener('change', toggleAlertFields);
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
    case 'test-mail-profile': openMailProfileTest(); break;
    case 'send-mail-test': sendMailTest(target.dataset.profile); break;
    case 'toggle-environment': toggleEnvironment(); break;
    case 'run': runJob(id); break;
    case 'edit': editJob(id); break;
    case 'stop': stopJob(id); break;
    case 'start': startJob(id); break;
    case 'duplicate': duplicateJob(id); break;
    case 'delete-job': deleteJob(id); break;
    case 'executions': showExecutions(id); break;
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
  messageBox('<p>' + tr('disableScheduleBody') + '</p>', tr('disableScheduleTitle'), tr('disableSchedule'), tr('cancel'), function() {
    $.post(routes.stop, {_id: _id}, function(result) {
      updateJobStatus(result.id, result.stopped);
    }).fail(handleOperationFailure);
  });
}

function startJob(_id) {
  messageBox('<p>' + tr('enableScheduleBody') + '</p>', tr('enableScheduleTitle'), tr('enableSchedule'), tr('cancel'), function() {
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
  row.classList.toggle('job-row-stopped', stopped);
  var button = row.querySelector('[data-toggle-job]');
  if (!button) return;
  button.dataset.action = stopped ? 'start' : 'stop';
  var label = stopped ? tr('enableSchedule') : tr('disableSchedule');
  button.setAttribute('title', label);
  button.setAttribute('aria-label', label);
  button.classList.toggle('btn-schedule-enable', stopped);
  button.classList.toggle('btn-schedule-disable', !stopped);
  setButtonIconAndLabel(button, stopped ? 'bi-power' : 'bi-stop-fill', label, stopped ? tr('enable') : tr('pause'));
  updateScheduleStateBadge(row, stopped);
}

function setButtonIconAndLabel(button, iconClass, label, actionLabel) {
  var icon = document.createElement('i');
  icon.className = 'bi ' + iconClass;
  icon.setAttribute('aria-hidden', 'true');
  var hiddenLabel = document.createElement('span');
  hiddenLabel.className = 'visually-hidden';
  hiddenLabel.textContent = label;
  if (actionLabel) {
    var visibleLabel = document.createElement('span');
    visibleLabel.className = 'action-label';
    visibleLabel.textContent = actionLabel;
    button.replaceChildren(icon, visibleLabel, hiddenLabel);
    return;
  }
  button.replaceChildren(icon, hiddenLabel);
}

function updateScheduleStateBadge(row, stopped) {
  var badge = row.querySelector('[data-job-schedule-state]');
  if (!stopped) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'job-state job-state-stopped';
    badge.dataset.jobScheduleState = '';
    var meta = row.querySelector('.job-meta');
    if (!meta) return;
    meta.prepend(badge);
  }
  badge.replaceChildren();
  var icon = document.createElement('i');
  icon.className = 'bi bi-stop-circle-fill';
  icon.setAttribute('aria-hidden', 'true');
  badge.append(icon, document.createTextNode(tr('disabled')));
}

function trackManualRun(jobId, operationId) {
  var button = document.querySelector('[data-action="run"][data-id="' + jobId + '"]');
  if (button) {
    button.disabled = true;
    button.setAttribute('aria-label', tr('run'));
    button.innerHTML = '<span class="spinner-border spinner-border-sm" aria-hidden="true"></span><span class="visually-hidden">' + tr('run') + '</span>';
  }
  var cancelButton = null;
  if (button && button.parentNode) {
    cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'btn btn-sm btn-outline-danger ms-1';
    cancelButton.title = tr('stopExecution');
    cancelButton.setAttribute('aria-label', tr('stopExecution'));
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
      if (button) {
        button.disabled = false;
        button.setAttribute('title', tr('runNow'));
        button.setAttribute('aria-label', tr('runNow'));
        setButtonIconAndLabel(button, 'bi-play-fill', tr('runNow'), tr('run'));
      }
      if (cancelButton) cancelButton.remove();
      try { sessionStorage.removeItem('crontab_ui_manual_run'); } catch (_error) { /* optional persistence */ }
      var auditOperationId = tr('auditOperationId', { operationId: operationId });
      var message = run.status === 'completed' ? tr('runSuccess', { auditOperationId: auditOperationId })
        : run.status === 'cancelled' ? tr('runStopped', { auditOperationId: auditOperationId })
          : tr('runFailed', { auditOperationId: auditOperationId });
      infoMessageBox(message, run.status === 'failed' ? tr('error') : tr('runComplete'));
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
    $('#job-mail-profile').val(job.mailing && job.mailing.profileId ? job.mailing.profileId : '');
    $('#job-mail-policy').val(job.mailing && job.mailing.policy ? job.mailing.policy : 'onFailure');
    fillAlertFields(job.mailing || {});
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
    var mailing = mailingFromForm();
    var logging = $('#job-logging').prop('checked');
    $.post(routes.save, {name: name, command: collapsedCommand(), schedule: schedule, _id: _id, logging: logging, mailing: mailing}, function() {
      location.reload();
    }).fail(handleOperationFailure);
    getModal('job').hide();
  });
}

// The alert threshold and cooldown only apply to a task that has a profile to alert through.
// Values that fall outside the range the server accepts are dropped rather than sent, so a
// half-typed number cannot make the whole save fail.
function mailingFromForm() {
  var profileId = $('#job-mail-profile').val();
  if (!profileId) return {};
  var mailing = { profileId: profileId, policy: $('#job-mail-policy').val() };
  var after = parseInt($('#job-alert-after').val(), 10);
  var cooldown = parseInt($('#job-alert-cooldown').val(), 10);
  if (!isNaN(after) && after >= 1 && after <= 100) mailing.alertAfterFailures = after;
  if (!isNaN(cooldown) && cooldown >= 0 && cooldown <= 10080) mailing.alertCooldownMinutes = cooldown;
  return mailing;
}

function fillAlertFields(mailing) {
  $('#job-alert-after').val(mailing && mailing.alertAfterFailures ? mailing.alertAfterFailures : 1);
  $('#job-alert-cooldown').val(mailing && mailing.alertCooldownMinutes !== undefined ? mailing.alertCooldownMinutes : 60);
  toggleAlertFields();
}

function toggleAlertFields() {
  var hasProfile = Boolean($('#job-mail-profile').val());
  $('#job-alert-threshold-fields').toggleClass('d-none', !hasProfile);
  $('#job-alert-help').toggleClass('d-none', !hasProfile);
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
  $('#job-mail-profile').val('');
  $('#job-mail-policy').val('onFailure');
  fillAlertFields({});
  job_string();

  var saveBtn = document.getElementById('job-save');
  var newSaveBtn = saveBtn.cloneNode(true);
  saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
  newSaveBtn.addEventListener('click', function() {
    if (!schedule) schedule = '* * * * *';
    var name = $('#job-name').val();
    var mailing = mailingFromForm();
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

function openMailProfileTest() {
  var status = document.getElementById('mail-profile-status');
  if (status) status.textContent = '';
  getModal('mail-profile-modal').show();
}

function sendMailTest(profileId) {
  var status = document.getElementById('mail-profile-status');
  var row = document.querySelector('[data-mail-profile="' + profileId + '"]');
  var button = row ? row.querySelector('[data-action="send-mail-test"]') : null;
  var buttons = document.querySelectorAll('#mail-profile-list [data-action="send-mail-test"]');
  if (status) status.textContent = tr('testMailProfileSending');
  if (button) button.disabled = true;
  for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
  $.post(routes.test_mail_profile, { profileId: profileId }, function() {
    if (status) status.textContent = tr('testMailProfileSent');
  }).fail(function(response) {
    var category = response && response.responseJSON ? response.responseJSON.category : null;
    var message = tr('testMailProfileError_' + (category || 'unavailable'));
    if (response && response.status === 429) message = tr('testMailProfileError_throttled');
    if (status) status.textContent = tr('testMailProfileFailed') + ' ' + message + ' ' + tr('mailProfileDetail');
  }).always(function() {
    if (button) button.disabled = false;
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = false;
  });
}

function executionsCell(value) {
  var cell = document.createElement('td');
  cell.textContent = value;
  return cell;
}

function formatDuration(milliseconds) {
  if (typeof milliseconds !== 'number' || !isFinite(milliseconds)) return '—';
  if (milliseconds < 1000) return milliseconds + ' ms';
  if (milliseconds < 60000) return (milliseconds / 1000).toFixed(1) + ' s';
  return Math.floor(milliseconds / 60000) + 'm ' + Math.round((milliseconds % 60000) / 1000) + 's';
}

function executionStatusLabel(run) {
  if (run.terminationReason) return tr('terminated_' + run.terminationReason);
  return run.status === 'completed' ? tr('succeeded') : tr('failed');
}

function renderExecutions(panel) {
  if ($.fn.dataTable.isDataTable('#executions-table')) {
    $('#executions-table').DataTable().destroy();
  }
  var summary = document.getElementById('executions-summary');
  summary.textContent = '';
  var rows = [
    [tr('lastRun'), panel.lastRun ? new Date(panel.lastRun.completedAt).toLocaleString() : tr('never')],
    [tr('lastRunResult'), panel.lastRun ? executionStatusLabel(panel.lastRun) : tr('never')],
    [tr('lastSuccess'), panel.lastSuccess ? new Date(panel.lastSuccess.completedAt).toLocaleString() : tr('never')],
    [tr('nextRun'), panel.stopped ? tr('schedulePaused') : (panel.nextRun ? new Date(panel.nextRun).toLocaleString() : tr('unavailable'))],
    [tr('consecutiveFailures'), String(panel.consecutiveFailures)],
    [tr('lastAlertSent'), panel.alert ? new Date(panel.alert.lastAlertAt).toLocaleString() : tr('never')]
  ];
  rows.forEach(function(entry) {
    var term = document.createElement('dt');
    term.className = 'col-6 col-sm-5';
    term.textContent = entry[0];
    var value = document.createElement('dd');
    value.className = 'col-6 col-sm-5 text-end';
    value.textContent = entry[1];
    summary.appendChild(term);
    summary.appendChild(value);
  });

  var body = document.getElementById('executions-body');
  body.textContent = '';
  panel.history.forEach(function(run) {
    var row = document.createElement('tr');
    if (run.status !== 'completed') row.className = 'table-danger';
    var trigger = run.trigger === 'manual' ? tr('manual') : tr('scheduled');
    if (run.actor) trigger += ' (' + run.actor + ')';
    row.appendChild(executionsCell(new Date(run.completedAt).toLocaleString()));
    row.appendChild(executionsCell(trigger));
    row.appendChild(executionsCell(executionStatusLabel(run)));
    row.appendChild(executionsCell(formatDuration(run.durationMs)));
    row.appendChild(executionsCell(run.exitCode === null || run.exitCode === undefined ? (run.signal || '—') : String(run.exitCode)));
    body.appendChild(row);
  });
  document.getElementById('executions-empty').hidden = panel.history.length > 0;
  document.getElementById('executions-content').classList.remove('d-none');
  if (panel.history.length > 0) {
    $('#executions-table').DataTable({
      pageLength: 5,
      lengthMenu: [5, 10, 25, 50],
      searching: false,
      ordering: false,
      autoWidth: false,
      language: {
        lengthMenu: tr('dataPerPage'),
        info: tr('executionPageInfo'),
        infoEmpty: tr('executionsEmpty'),
        emptyTable: tr('executionsEmpty'),
        paginate: { first: '\u00ab', last: '\u00bb', next: '\u203a', previous: '\u2039' }
      },
      drawCallback: function() {
        var api = this.api();
        var pager = api.table().container().querySelector('.dt-paging');
        if (pager) pager.classList.toggle('d-none', api.page.info().pages <= 1);
      }
    });
  }
}

function showExecutions(jobId) {
  var loading = document.getElementById('executions-loading');
  var failure = document.getElementById('executions-error');
  var content = document.getElementById('executions-content');
  content.classList.add('d-none');
  failure.classList.add('d-none');
  failure.textContent = '';
  loading.classList.remove('d-none');
  getModal('executions-modal').show();
  $.get(routes.executions, { id: jobId }, function(panel) {
    loading.classList.add('d-none');
    document.getElementById('executions-task-name').textContent = panel.name;
    renderExecutions(panel);
  }).fail(function() {
    loading.classList.add('d-none');
    failure.textContent = tr('executionsUnavailable');
    failure.classList.remove('d-none');
  });
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
  var expression = schedule || scheduleFromFields();
  var preview = document.getElementById('job-string');
  if (preview) preview.textContent = expression || '* * * * *';
  updateScheduleDescription(expression);
  return expression;
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
