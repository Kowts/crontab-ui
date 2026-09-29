'use strict';

const baseUrl = (process.env.BASE_URL || '').replace(/\/+$/, '').trim();

const routes = {
  root: '/',
  health: '/healthz',
  save: '/save',
  run: '/runjob',
  run_status: '/runjob/status',
  cancel_run: '/runjob/cancel',
  crontab: '/crontab',
  stop: '/stop',
  start: '/start',
  remove: '/remove',
  backup: '/backup',
  restore: '/restore',
  delete_backup: '/delete',
  restore_backup: '/restore_backup',
  export: '/export',
  test_mail_profile: '/test_mail_profile',
  import: '/import',
  import_crontab: '/import_crontab',
  logger: '/logger',
  executions: '/executions',
  stdout: '/stdout',
  preview_crontab: '/preview_crontab',
  locale: '/locale',
  login: '/login',
  logout: '/logout',
};

exports.base_url = baseUrl;

exports.routes = Object.fromEntries(
  Object.entries(routes).map(([k, v]) => [k, baseUrl + v])
);

exports.relative = Object.fromEntries(
  Object.entries(routes).map(([k, v]) => [k, v.replace(/^\//, '')])
);
exports.relative.root = baseUrl;
