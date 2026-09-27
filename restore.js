'use strict';

const path = require('path');
const fs = require('fs');
const crontab = require('./crontab');
const { readJobsFromFile } = require('./lib/database');

exports.crontabs = (dbName, callback) => {
  try {
    callback(readJobsFromFile(path.join(crontab.db_folder, dbName)));
  } catch (_error) {
    callback([]);
  }
};

exports.delete = (dbName) => {
  fs.unlink(path.join(crontab.db_folder, dbName), (err) => {
    if (err) {
      console.log(`Delete error: ${err}`);
    } else {
      console.log('Backup deleted');
    }
  });
};
