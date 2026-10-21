// A tiny SMTP server for tests: accepts everything and keeps the messages it receives.
import net from 'node:net';

export async function startSmtp() {
  const messages = [];
  const server = net.createServer((socket) => {
    let data = false;
    let buffer = '';
    let current = { from: null, to: [], raw: '' };
    socket.write('220 test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let index;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (data) {
          if (line === '.') {
            data = false;
            messages.push(current);
            current = { from: null, to: [], raw: '' };
            socket.write('250 OK queued\r\n');
          } else {
            current.raw += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          }
          continue;
        }
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO' || command === 'HELO') socket.write('250-test\r\n250 SIZE 10000000\r\n');
        else if (command === 'MAIL') { current.from = line; socket.write('250 OK\r\n'); }
        else if (command === 'RCPT') {
          if (line.includes('rifiuta@')) socket.write('550 5.1.1 No such user\r\n');
          else { current.to.push(/<([^>]+)>/.exec(line)?.[1]); socket.write('250 OK\r\n'); }
        } else if (command === 'DATA') { data = true; socket.write('354 go\r\n'); }
        else if (command === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return {
    port: server.address().port,
    messages,
    close: () => new Promise((resolve) => { server.close(resolve); }),
  };
}
