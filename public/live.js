// Live updates of an event for the wall and print pages: a WebSocket on /api/events/<event>/live
// that reconnects by itself. A WebSocket does not take one of the browser's 6 connections per
// site (an EventSource does), so many open tabs never block the other requests.
// openLive(slug, { onOpen, onClose, on: { status(data), video(data), ... } })
window.openLive = function openLive(slug, { onOpen, onClose, on }) {
  let delay = 1000;
  function connect() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${location.host}/api/events/${encodeURIComponent(slug)}/live`);
    socket.addEventListener('open', () => {
      delay = 1000;
      if (onOpen) onOpen();
    });
    socket.addEventListener('message', (e) => {
      const { type, data } = JSON.parse(e.data);
      if (on[type]) on[type](data);
    });
    socket.addEventListener('close', () => {
      if (onClose) onClose();
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 10000);
    });
  }
  connect();
};
