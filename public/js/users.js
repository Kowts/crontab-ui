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

  function permissionLabels(user) {
    var permissions = user.effective_permissions || {};
    var labels = [];
    if (permissions.viewOwnedTasks) labels.push(tr('userCanViewOwned'));
    if (permissions.viewAllTasks) labels.push(tr('userCanViewAll'));
    if (permissions.executeOwnedTasks) labels.push(tr('userCanExecuteOwned'));
    if (permissions.manageOwnedTasks) labels.push(tr('userCanManageOwned'));
    if (permissions.manageUsers) labels.push(tr('userCanManageUsers'));
    if (permissions.manageEnvironments) labels.push(tr('userCanManageEnvironments'));
    return labels;
  }

  function renderPermissions(cell, user) {
    var labels = permissionLabels(user);
    var details = document.createElement('details');
    details.className = 'user-permissions';
    var summary = document.createElement('summary');
    var count = document.createElement('span');
    count.textContent = tr(labels.length === 1 ? 'userPermissionCountOne' : 'userPermissionCount')
      .replace('{count}', String(labels.length));
    summary.appendChild(count);
    var more = document.createElement('span');
    more.className = 'user-permissions-link';
    more.textContent = tr('userPermissionDetails');
    summary.appendChild(more);
    summary.setAttribute('aria-label', tr('userPermissionSummary') + ': ' + user.username);
    details.appendChild(summary);
    var list = document.createElement('ul');
    labels.forEach(function(label) {
      var item = document.createElement('li');
      item.textContent = label;
      list.appendChild(item);
    });
    details.appendChild(list);
    var note = document.createElement('p');
    note.className = 'small text-muted mb-0';
    note.textContent = tr(user.role === 'admin' ? 'userAdminScope' : 'userOwnedScope');
    if (user.role === 'operator') {
      note.textContent += ' ' + tr(user.effective_permissions?.executeOwnedTasks
        ? 'userOperatorEnabled' : 'userOperatorDisabled');
    }
    if (!user.active) note.textContent += ' ' + tr('userInactiveAccess');
    details.appendChild(note);
    cell.appendChild(details);
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
    body.querySelectorAll('[data-bs-toggle="dropdown"]').forEach(function(button) {
      bootstrap.Dropdown.getInstance(button)?.dispose();
    });
    body.replaceChildren();
    document.getElementById('users-empty').hidden = users.length > 0;
    users.forEach(function(user) {
      var row = document.createElement('tr');
      var usernameCell = textCell(row, '');
      var username = document.createElement('strong');
      username.textContent = user.username;
      usernameCell.appendChild(username);
      textCell(row, roleName(user.role));
      var stateCell = textCell(row, '');
      var badge = document.createElement('span');
      badge.className = 'user-state ' + (user.active ? 'user-state-active' : 'user-state-inactive');
      badge.textContent = user.active ? tr('userActive') : tr('userInactive');
      stateCell.appendChild(badge);
      textCell(row, user.last_login_at ? new Date(user.last_login_at).toLocaleString() : tr('never'));
      renderPermissions(textCell(row, ''), user);

      var actions = document.createElement('td');
      actions.className = 'text-end text-nowrap';
      var edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn btn-sm btn-outline-secondary';
      edit.textContent = tr('edit');
      edit.setAttribute('aria-label', tr('userEdit') + ' ' + user.username);
      edit.addEventListener('click', function() { openUser(user); });
      var actionGroup = document.createElement('div');
      actionGroup.className = 'user-actions';
      actionGroup.appendChild(edit);
      var dropdown = document.createElement('div');
      dropdown.className = 'dropdown';
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'btn btn-sm btn-outline-secondary';
      toggle.setAttribute('data-bs-toggle', 'dropdown');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', tr('userActions') + ': ' + user.username);
      var icon = document.createElement('i');
      icon.className = 'bi bi-three-dots';
      icon.setAttribute('aria-hidden', 'true');
      toggle.appendChild(icon);
      dropdown.appendChild(toggle);
      var menu = document.createElement('div');
      menu.className = 'dropdown-menu dropdown-menu-end';
      var reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'dropdown-item';
      reset.textContent = tr('userResetPassword');
      reset.addEventListener('click', function() { openPasswordReset(user); });
      menu.appendChild(reset);
      var state = document.createElement('button');
      state.type = 'button';
      state.className = 'dropdown-item';
      state.textContent = user.active ? tr('userDeactivate') : tr('userActivate');
      state.addEventListener('click', function() { toggleUser(user); });
      menu.appendChild(state);
      dropdown.appendChild(menu);
      actionGroup.appendChild(dropdown);
      actions.appendChild(actionGroup);
      new bootstrap.Dropdown(toggle, { popperConfig: { strategy: 'fixed' } });
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
