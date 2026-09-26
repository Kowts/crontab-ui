'use strict';

var crontabs = [];
var routes = {};

function csrfToken() {
  var match = document.cookie.match(/(?:^|; )crontab_ui_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function initPage() {
  var jobs = document.getElementById('crontabs-state');
  var routeState = document.getElementById('routes-state');
  var env = document.getElementById('env-state');
  if (jobs) crontabs = JSON.parse(jobs.textContent);
  if (routeState) routes = JSON.parse(routeState.textContent);
  if (env) $('#env_vars').val(JSON.parse(env.textContent));

  $.ajaxSetup({ headers: { 'X-CSRF-Token': csrfToken() } });
  [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]')).forEach(function(el) {
    return new bootstrap.Tooltip(el);
  });
  if (document.getElementById('main_table')) {
    $('#main_table').DataTable({
      order: [[1, 'asc']], stateSave: true, stateDuration: 0,
      columns: [{ orderable: false }, null, null, null, { orderable: false }, { orderable: false }]
    });
  }
  var importInput = document.getElementById('import_file');
  if (importInput) importInput.addEventListener('change', function() {
    if (!this.files.length) return;
    fetch(document.getElementById('import_form').action, {
      method: 'POST', body: new FormData(document.getElementById('import_form')),
      headers: { 'X-CSRF-Token': csrfToken() }, credentials: 'same-origin'
    }).then(function(response) {
      if (response.ok) window.location.assign(response.url);
      else errorMessageBox('Import failed');
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
  });
  var copyButton = document.getElementById('copy-crontab');
  if (copyButton) copyButton.addEventListener('click', copyCrontab);
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
  document.getElementById('info-body').innerHTML = message;
  document.getElementById('info-title').innerHTML = title;
  getModal('info-popup').show();
}

function errorMessageBox(message) {
  var msg =
    'Operation failed: ' + message + '. ' +
    'Please see error log for details.';
  infoMessageBox(msg, 'Error');
}

function messageBox(body, title, ok_text, close_text, callback) {
  var modalBody = document.getElementById('modal-body');
  if (typeof body === 'string') {
    modalBody.innerHTML = body;
  } else {
    modalBody.innerHTML = '';
    modalBody.appendChild(body);
  }
  document.getElementById('modal-title').innerHTML = title;
  if (ok_text) document.getElementById('modal-button').innerHTML = ok_text;
  if (close_text) document.getElementById('modal-close-button').innerHTML = close_text;

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
  messageBox('<p> Do you want to delete this Job? </p>', 'Confirm delete', null, null, function() {
    $.post(routes.remove, {_id: _id}, function() {
      location.reload();
    });
  });
}

function stopJob(_id) {
  messageBox('<p> Do you want to stop this Job? </p>', 'Confirm stop job', null, null, function() {
    $.post(routes.stop, {_id: _id}, function() {
      location.reload();
    });
  });
}

function startJob(_id) {
  messageBox('<p> Do you want to start this Job? </p>', 'Confirm start job', null, null, function() {
    $.post(routes.start, {_id: _id}, function() {
      location.reload();
    });
  });
}

function runJob(_id) {
  messageBox('<p> Do you want to run this Job? </p>', 'Confirm run job', null, null, function() {
    $.post(routes.run, {_id: _id}, function() {
      location.reload();
    });
  });
}

function setCrontab() {
  messageBox('<p> Do you want to set the crontab file? </p>', 'Confirm crontab setup', null, null, function() {
    $.post(routes.crontab, { env_vars: $('#env_vars').val() }, function() {
      infoMessageBox('Successfully set crontab file!', 'Information');
      location.reload();
    }).fail(function(response) {
      errorMessageBox(response.statusText);
    });
  });
}

function getCrontab() {
  messageBox(
    '<p> Do you want to get the crontab file? <br /> A backup will be created automatically before importing.</p>',
    'Confirm crontab retrieval', null, null, function() {
    $.post(routes.import_crontab, {}, function() {
        infoMessageBox('Successfully got the crontab file!', 'Information');
        location.reload();
      });
    });
}

function editJob(_id) {
  var job = null;
  crontabs.forEach(function(crontab) {
    if (crontab._id == _id) job = crontab;
  });

  if (job) {
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
    if (job.logging && job.logging != 'false')
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
    });
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
    });
    getModal('job').hide();
  });
}

function duplicateJob(_id) {
  var job = null;
  crontabs.forEach(function(crontab) {
    if (crontab._id == _id) job = crontab;
  });
  if (!job) return;

  var name = job.name ? job.name + ' (copy)' : '';
  var logging = (job.logging && job.logging != 'false') ? job.logging : 'false';
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
  });
}

function doBackup() {
  messageBox('<p> Do you want to take backup? </p>', 'Confirm backup', null, null, function() {
    $.post(routes.backup, {}, function() {
      location.reload();
    });
  });
}

function delete_backup(db_name) {
  messageBox('<p> Do you want to delete this backup? </p>', 'Confirm delete', null, null, function() {
    $.post(routes.delete_backup, { db: db_name }, function() {
      location = routes.root;
    });
  });
}

function restore_backup(db_name) {
  messageBox('<p> Do you want to restore this backup? </p>', 'Confirm restore', null, null, function() {
    $.post(routes.restore_backup, { db: db_name }, function() {
      location = routes.root;
    });
  });
}

function import_db() {
  messageBox(
    '<p> Do you want to import crontab?<br /> A backup will be created automatically before importing.</p>',
    'Confirm import from crontab', null, null, function() {
      $('#import_file').click();
    });
}


function collapsedCommand() {
  return job_command.split(/\r?\n/).map(function(l) { return l.trim(); }).filter(Boolean).join('; ');
}

function job_string() {
  var cmd = collapsedCommand();
  $('#job-string').val(schedule + ' ' + cmd);
  return schedule + ' ' + cmd;
}

function set_schedule() {
  schedule = $('#job-minute').val() + ' ' + $('#job-hour').val() + ' ' + $('#job-day').val() + ' ' + $('#job-month').val() + ' ' + $('#job-week').val();
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
    btn.innerHTML = '<i class="bi bi-check2"></i> Copied!';
    setTimeout(function() {
      btn.innerHTML = '<i class="bi bi-clipboard"></i> Copy';
    }, 2000);
  });
}
