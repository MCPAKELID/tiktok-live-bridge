#!/usr/bin/env node
// Panel entry point.
// TikTok Live Connector 2.4.x requires Node.js 20+.
// Node.js 19 can fail while parsing the connector with:
// "Invalid regular expression flags".
const major = Number(process.versions.node.split('.')[0]);

if (!Number.isFinite(major) || major < 20) {
  console.error('');
  console.error('============================================================');
  console.error('TIKTOMC membutuhkan Node.js 20 atau lebih baru.');
  console.error(`Node.js saat ini: ${process.versions.node}`);
  console.error('');
  console.error('Di panel WispByte, ubah runtime/server image ke Node.js 20+.');
  console.error('Disarankan Node.js 22 LTS.');
  console.error('');
  console.error('Error "Invalid regular expression flags" pada Node 19');
  console.error('berasal dari kompatibilitas runtime TikTok Live Connector.');
  console.error('============================================================');
  console.error('');
  process.exit(1);
}

require('./main.js');
