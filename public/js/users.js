'use strict';

(function() {
  var routes = JSON.parse(document.getElementById('routes-state').textContent);
  var i18n = JSON.parse(document.getElementById('i18n-state').textContent);
  var pageSize = 50;
  var offset = 0;
  var total = 0;
  var users = [];
  var currentUser = null;
  var resetUser = null;
  var userModal = bootstrap.Modal.getOrCreateInstance(document.getElementById('user-modal'));
  var passwordModal = bootstrap.Modal.getOrCreateInstance(document.getElementById('user-password-modal'));
  var searchTimer;

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

  function roleName(role) {
    return tr({ viewer: 'viewer', executor: 'executor', operator: 'operator', admin: 'admin' }[role] || 'userRole');
  }

  function permissionSummary(user) {
    var permissions = user.effective_permissions || {};
    var labels = [];
    if (permissions.viewOwnedTasks) labels.push(tr('userCanViewOwned'));
    if (permissions.viewAllTasks) labels.push(tr('userCanViewAll'));
    if (permissions.executeOwnedTasks) labels.push(tr('userCanExecuteOwned'));
    if (permissions.manageOwnedTasks) labels.push(tr('userCanManageOwned'));
    if (permissions.manageUsers) labels.push(tr('userCanManageUsers'));
    if (permissions.manageEnvironments) labels.push(tr('userCanManageEnvironments'));
    return labels.join(' · ');
  }

  function textCell(row, value, className) {
    var cell = document.createElement('td');
    if (className) cell.className = className;
    cell.textContent = value;
    row.appendChild(cell);
    return cell;
  }

  function showError(id, message) {
    var element = document.getElementById(id);
    element.textContent = message;
    element.hidden = false;
  }

  function renderRows() {
    var body = document.getElementById('users-body');
    body.replaceChildren();
    document.getElementById('users-empty').hidden = users.length > 0;
    users.forEach(function(user) {
      var row = document.createElement('tr');
      var usernameCell = textCell(row, '');
      var username = document.createElement('strong');
      username.textContent = user.username;
      usernameCell.appendChild(username);
      textCell(row, roleName(user.role));
      textCell(row, user.active ? tr('userActive') : tr('userInactive'));
      textCell(row, user.last_login_at ? new Date(user.last_login_at).toLocaleString() : tr('never'));
      textCell(row, permissionSummary(user), 'small text-muted');

      var actions = document.createElement('td');
      actions.className = 'text-end text-nowrap';
      var edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn btn-sm btn-outline-secondary me-1';
      edit.textContent = tr('edit');
      edit.setAttribute('aria-label', tr('userEdit') + ' ' + user.username);
      edit.addEventListener('click', function() { openUser(user); });
      actions.appendChild(edit);
      var reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'btn btn-sm btn-outline-secondary me-1';
      reset.textContent = tr('userResetPassword');
      reset.addEventListener('click', function() { openPasswordReset(user); });
      actions.appendChild(reset);
      var state = document.createElement('button');
      state.type = 'button';
      state.className = 'btn btn-sm btn-outline-secondary';
      state.textContent = user.active ? tr('userDeactivate') : tr('userActivate');
      state.addEventListener('click', function() { toggleUser(user); });
      actions.appendChild(state);
      row.appendChild(actions);
      body.appendChild(row);
    });
    var first = total ? offset + 1 : 0;
    var last = offset + users.length;
    document.getElementById('users-page-status').textContent = first + '–' + last + ' / ' + total;
    document.getElementById('users-previous').disabled = offset === 0;
    document.getElementById('users-next').disabled = last >= total;
  }

  function loadUsers() {
    var query = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
    var search = document.getElementById('user-search').value.trim();
    var role = document.getElementById('user-role-filter').value;
    var active = document.getElementById('user-state-filter').value;
    if (search) query.set('q', search);
    if (role) query.set('role', role);
    if (active) query.set('active', active);
    var status = document.getElementById('users-status');
    status.textContent = '';
    return api(routes.users + '?' + query.toString()).then(function(result) {
      users = result.items;
      total = result.total;
      renderRows();
    }).catch(function(response) {
      users = [];
      total = 0;
      renderRows();
      status.textContent = response.responseJSON?.message || tr('userFormError');
    });
  }

  function updateRoleDescription() {
    var role = document.getElementById('user-role').value;
    document.getElementById('user-role-description').textContent = tr({
      viewer: 'userRoleViewer', executor: 'userRoleExecutor', operator: 'userRoleOperator', admin: 'userRoleAdmin',
    }[role]);
  }

  function openUser(user) {
    currentUser = user || null;
    document.getElementById('user-modal-title').textContent = user ? tr('userEdit') : tr('userCreate');
    document.getElementById('user-username').value = user ? user.username : '';
    document.getElementById('user-username').disabled = Boolean(user);
    document.getElementById('user-password-field').hidden = Boolean(user);
    document.getElementById('user-password').value = '';
    document.getElementById('user-role').value = user ? user.role : 'viewer';
    document.getElementById('user-active-field').hidden = !user;
    document.getElementById('user-active').checked = user ? user.active : true;
    document.getElementById('user-form-error').hidden = true;
    document.getElementById('user-save').textContent = user ? tr('userSave') : tr('userCreate');
    updateRoleDescription();
    userModal.show();
  }

  function saveUser() {
    var payload;
    var url = routes.users;
    var method = 'POST';
    if (currentUser) {
      payload = {
        revision: currentUser.revision,
        role: document.getElementById('user-role').value,
        active: document.getElementById('user-active').checked,
      };
      url += '/' + encodeURIComponent(currentUser.id);
      method = 'PATCH';
    } else {
      payload = {
        username: document.getElementById('user-username').value,
        password: document.getElementById('user-password').value,
        role: document.getElementById('user-role').value,
      };
    }
    var button = document.getElementById('user-save');
    button.disabled = true;
    api(url, method, payload).done(function(result) {
      document.getElementById('user-password').value = '';
      if (result.current_session_revoked) {
        window.location.assign(routes.login);
        return;
      }
      userModal.hide();
      document.getElementById('users-status').textContent = currentUser ? tr('userUpdateSuccess') : tr('userCreateSuccess');
      loadUsers();
    }).fail(function(response) {
      showError('user-form-error', response.responseJSON?.message || tr('userFormError'));
    }).always(function() { button.disabled = false; });
  }

  function toggleUser(user) {
    var active = !user.active;
    if (!window.confirm(tr(active ? 'userConfirmActivate' : 'userConfirmDeactivate'))) return;
    api(routes.users + '/' + encodeURIComponent(user.id) + '/' + (active ? 'activate' : 'deactivate'), 'POST', {
      revision: user.revision,
    }).done(function(result) {
      if (result.current_session_revoked) {
        window.location.assign(routes.login);
        return;
      }
      loadUsers();
    }).fail(function(response) {
      document.getElementById('users-status').textContent = response.responseJSON?.message || tr('userFormError');
    });
  }

  function openPasswordReset(user) {
    resetUser = user;
    document.getElementById('user-password-description').textContent = user.username;
    document.getElementById('user-new-password').value = '';
    document.getElementById('user-password-error').hidden = true;
    passwordModal.show();
  }

  function resetPassword() {
    if (!resetUser) return;
    var button = document.getElementById('user-password-save');
    button.disabled = true;
    api(routes.users + '/' + encodeURIComponent(resetUser.id) + '/reset-password', 'POST', {
      revision: resetUser.revision,
      password: document.getElementById('user-new-password').value,
    }).done(function(result) {
      document.getElementById('user-new-password').value = '';
      passwordModal.hide();
      if (result.current_session_revoked) {
        window.location.assign(routes.login);
        return;
      }
      document.getElementById('users-status').textContent = tr('userPasswordResetSuccess');
      loadUsers();
    }).fail(function(response) {
      showError('user-password-error', response.responseJSON?.message || tr('userFormError'));
    }).always(function() { button.disabled = false; });
  }

  document.getElementById('user-add').addEventListener('click', function() { openUser(null); });
  document.getElementById('user-save').addEventListener('click', saveUser);
  document.getElementById('user-password-save').addEventListener('click', resetPassword);
  document.getElementById('user-role').addEventListener('change', updateRoleDescription);
  document.getElementById('user-search').addEventListener('input', function() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function() { offset = 0; loadUsers(); }, 200);
  });
  ['user-role-filter', 'user-state-filter'].forEach(function(id) {
    document.getElementById(id).addEventListener('change', function() { offset = 0; loadUsers(); });
  });
  document.getElementById('users-previous').addEventListener('click', function() {
    offset = Math.max(0, offset - pageSize);
    loadUsers();
  });
  document.getElementById('users-next').addEventListener('click', function() {
    if (offset + pageSize < total) { offset += pageSize; loadUsers(); }
  });

  loadUsers();
})();
