// Tiny JSON-file store. Fine for one owner and a modest upload volume.
const fs = require('fs');
const path = require('path');

const dir = path.resolve(process.env.DATA_DIR || './data');
const file = path.join(dir, 'db.json');

let db = { google: null, links: [], uploads: [] };

function load() {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) db = { ...db, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function save() {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, file);
}

load();

module.exports = {
  get: () => db,
  save,
};
