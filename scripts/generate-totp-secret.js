#!/usr/bin/env node
const { randomBytes } = require('node:crypto');

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = '';
  let output = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  for (let index = 0; index < bits.length; index += 5) {
    const chunk = bits.slice(index, index + 5).padEnd(5, '0');
    output += alphabet[Number.parseInt(chunk, 2)];
  }
  return output;
}

const account = process.argv[2] || 'claude-web-chat';
const issuer = process.argv[3] || 'Claude Web Chat';
const secret = base32Encode(randomBytes(20));
const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

console.log('TOTP secret for Google Authenticator:');
console.log(secret);
console.log('\nAdd this to config.json:');
console.log(JSON.stringify({ auth: { enabled: true, totp: { enabled: true, secret } } }, null, 2));
console.log('\nManual setup URI:');
console.log(uri);
