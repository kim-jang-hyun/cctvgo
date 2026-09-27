'use strict';
const net = require('net');

/** 아무도 듣고 있지 않은 로컬 포트를 하나 얻는다 */
function getClosedPort() {
    return new Promise(resolve => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const port = s.address().port;
            s.close(() => resolve(port));
        });
    });
}

module.exports = { getClosedPort };
