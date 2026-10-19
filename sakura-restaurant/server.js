const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// Get local IPv4 address
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

// Connected SSE clients
const sseClients = new Set();

function broadcastSse(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(msg);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// SSE Keep-Alive Heartbeat every 12 seconds (prevents mobile/tablet/Edge disconnection)
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(': ping\n\n');
    } catch (e) {
      sseClients.delete(client);
    }
  }
}, 12000);

const server = http.createServer((req, res) => {
  // CORS Headers for multi-device Wi-Fi and localhost/file access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Private-Network': 'true'
    });
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  if (pathname !== '/api/events' && pathname !== '/api/data') {
    console.log(`[${new Date().toLocaleTimeString('th-TH')}] ${req.method} ${pathname}`);
  }

  // 1. SSE Stream: Real-Time Multi-Device Events
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Private-Network': 'true'
    });
    res.write('retry: 1500\n\n');
    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // 2. API GET: Retrieve current data.json from Drive D
  if (pathname === '/api/data' && req.method === 'GET') {
    fs.readFile(DATA_FILE, 'utf8', (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ error: 'data.json not found' }));
      } else {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=UTF-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Private-Network': 'true'
        });
        res.end(content);
      }
    });
    return;
  }

  // 2.5 API GET: Retrieve Server LAN Information (supports JSON and JSONP)
  if (pathname === '/api/server-info' && req.method === 'GET') {
    const callback = parsedUrl.searchParams.get('callback');
    const infoPayload = {
      online: true,
      localIp: getLocalIp(),
      port: PORT,
      lanUrl: `http://${getLocalIp()}:${PORT}`
    };

    if (callback && /^[a-zA-Z0-9_]+$/.test(callback)) {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=UTF-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(`${callback}(${JSON.stringify(infoPayload)});`);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Private-Network': 'true'
    });
    res.end(JSON.stringify(infoPayload));
    return;
  }

  // 3. API POST: Save and persist data directly into data.json on Drive D
  if (pathname === '/api/save' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        payload.lastSavedOnDisk = new Date().toISOString();
        fs.writeFile(DATA_FILE, JSON.stringify(payload, null, 2), 'utf8', (err) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
            res.end(JSON.stringify({ success: false, error: err.message }));
          } else {
            // Broadcast update to all connected devices in the restaurant
            broadcastSse({
              action: payload.action || 'DATA_CHANGED',
              sender: payload.sender,
              timestamp: Date.now(),
              data: payload
            });
            res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
            res.end(JSON.stringify({ success: true, timestamp: Date.now() }));
          }
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // 3.5 API POST: Atomic order placement from customer QR or direct link
  if (pathname === '/api/place-order' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const orderData = JSON.parse(body);
        const orderTable = String(orderData.table || '1').trim();
        fs.readFile(DATA_FILE, 'utf8', (readErr, content) => {
          let db = {};
          try { db = JSON.parse(content || '{}'); } catch (e) { db = {}; }
          if (!Array.isArray(db.orders)) db.orders = [];
          if (!Array.isArray(db.openBills)) db.openBills = [];

          const newOrderId = (typeof db.nextOrderId === 'number' && db.nextOrderId > 0) ? db.nextOrderId : (db.orders.length + 1);
          db.nextOrderId = newOrderId + 1;

          const newOrder = {
            id: newOrderId,
            table: orderTable,
            staffId: orderData.staffId || 1,
            staffName: orderData.staffName || 'พนักงาน',
            commissionRate: orderData.commissionRate || 5,
            commissionAmount: orderData.commissionAmount || 0,
            items: orderData.items || [],
            subtotal: orderData.subtotal || 0,
            total: orderData.total || 0,
            note: orderData.note || '',
            date: new Date().toISOString(),
            status: 'กำลังทำ',
            kitchenAccepted: false
          };
          db.orders.push(newOrder);

          // Update existing open bill or create new bill for this table
          let targetBill = db.openBills.find(b => String(b.table) === orderTable && b.status === 'open');
          if (targetBill) {
            if (!Array.isArray(targetBill.items)) targetBill.items = [];
            (orderData.items || []).forEach(it => {
              const mId = it.menuId || it.id;
              const itNote = (it.note || '').trim();
              const existingIt = targetBill.items.find(x => (x.menuId === mId || x.id === mId) && (x.note || '').trim() === itNote);
              if (existingIt) {
                existingIt.qty = (Number(existingIt.qty) || 0) + (Number(it.qty) || 1);
              } else {
                targetBill.items.push(it);
              }
            });
            if (orderData.note) {
              targetBill.note = targetBill.note ? `${targetBill.note}, ${orderData.note}` : orderData.note;
            }
          } else {
            const newBillId = (typeof db.nextBillId === 'number' && db.nextBillId > 0) ? db.nextBillId : (db.openBills.length + 1);
            db.nextBillId = newBillId + 1;
            targetBill = {
              id: newBillId,
              billNo: 'BILL-' + (1000 + newBillId),
              table: orderTable,
              staffId: orderData.staffId || 1,
              staffName: orderData.staffName || 'พนักงาน',
              commissionRate: orderData.commissionRate || 5,
              openedAt: new Date().toLocaleString('sv-SE').replace(' ', 'T'),
              status: 'open',
              note: orderData.note || '',
              items: [...(orderData.items || [])]
            };
            db.openBills.unshift(targetBill);
          }

          db.timestamp = Date.now();
          db.lastSavedOnDisk = new Date().toISOString();

          fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), 'utf8', (writeErr) => {
            if (writeErr) {
              res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
              res.end(JSON.stringify({ success: false, error: writeErr.message }));
            } else {
              console.log(`[${new Date().toLocaleTimeString('th-TH')}] 🔔 NEW ORDER received for Table ${orderTable} (#${newOrder.id}): ${(newOrder.items || []).map(i => i.name + 'x' + i.qty).join(', ')}`);
              broadcastSse({
                action: 'ORDER_PLACED',
                table: orderTable,
                orderId: newOrder.id,
                itemsCount: (newOrder.items || []).length,
                timestamp: db.timestamp,
                allOrders: db.orders,
                allOpenBills: db.openBills,
                nextOrderId: db.nextOrderId,
                nextBillId: db.nextBillId
              });
              res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
              res.end(JSON.stringify({
                success: true,
                order: newOrder,
                bill: targetBill,
                allOrders: db.orders,
                allOpenBills: db.openBills,
                nextOrderId: db.nextOrderId,
                nextBillId: db.nextBillId,
                timestamp: db.timestamp
              }));
            }
          });
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON: ' + e.message }));
      }
    });
    return;
  }

  // 3.6 API POST: Update order status (e.g. กำลังทำ -> เสร็จสิ้น, or acknowledge/accept)
  if (pathname === '/api/update-order-status' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { orderId, status, kitchenAccepted } = JSON.parse(body);
        fs.readFile(DATA_FILE, 'utf8', (readErr, content) => {
          let db = {};
          try { db = JSON.parse(content || '{}'); } catch (e) { db = {}; }
          if (Array.isArray(db.orders)) {
            if (orderId === 'all') {
              // Accept all currently pending/cooking orders
              db.orders.forEach(o => {
                if (o.status === 'กำลังทำ' || o.status === 'รอรับออเดอร์') {
                  o.kitchenAccepted = true;
                  if (status && status !== 'keep') o.status = status;
                }
              });
              db.timestamp = Date.now();
              db.lastSavedOnDisk = new Date().toISOString();
              fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), 'utf8', (wErr) => {
                if (!wErr) {
                  console.log(`[${new Date().toLocaleTimeString('th-TH')}] 🍳 All kitchen orders acknowledged/accepted`);
                  broadcastSse({
                    action: 'ORDER_STATUS_CHANGED',
                    orderId: 'all',
                    status: 'accepted_all',
                    timestamp: db.timestamp,
                    allOrders: db.orders
                  });
                }
              });
            } else {
              const ord = db.orders.find(o => o.id === orderId);
              if (ord) {
                if (status) ord.status = status;
                if (typeof kitchenAccepted === 'boolean') {
                  ord.kitchenAccepted = kitchenAccepted;
                }
                db.timestamp = Date.now();
                db.lastSavedOnDisk = new Date().toISOString();
                fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), 'utf8', (wErr) => {
                  if (!wErr) {
                    console.log(`[${new Date().toLocaleTimeString('th-TH')}] 🍳 Order #${orderId} status updated: ${ord.status} (accepted: ${ord.kitchenAccepted})`);
                    broadcastSse({
                      action: 'ORDER_STATUS_CHANGED',
                      orderId,
                      status: ord.status,
                      kitchenAccepted: ord.kitchenAccepted,
                      timestamp: db.timestamp,
                      allOrders: db.orders
                    });
                  }
                });
              }
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ success: true, allOrders: db.orders, timestamp: db.timestamp }));
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // 4. Static File Server
  let targetPath = pathname;
  if (targetPath === '/' || targetPath === '') {
    targetPath = '/index.html';
  }

  const filePath = path.join(__dirname, targetPath);

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=UTF-8' });
        res.end('<h1>404 - ไม่พบไฟล์ที่เรียก</h1><p><a href="/">กลับหน้าหลัก</a></p>');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const headers = { 'Content-Type': contentType };
      if (ext === '.html' || ext === '.json') {
        headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      }
      res.writeHead(200, headers);
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIp();
  console.log('================================================================');
  console.log('  🌸 Sakura Restaurant System - เว็บเซิร์ฟเวอร์พร้อมทำงาน! 🌸');
  console.log('  💾 บันทึกและซิงค์ข้อมูลลง D:\\sakura-restaurant\\data.json แบบ Real-Time');
  console.log('================================================================');
  console.log(`\n💻 เข้าใช้งานบนเครื่องนี้ (Localhost):`);
  console.log(`   - หน้าหลัก / แคชเชียร์:  http://localhost:${PORT}/`);
  console.log(`   - หน้าโต๊ะ 1 (ลูกค้า):   http://localhost:${PORT}/?table=1`);
  console.log(`   - หน้าโต๊ะ 2 (ลูกค้า):   http://localhost:${PORT}/?table=2`);
  console.log(`\n📱 เข้าใช้งานจากมือถือ / แท็บเล็ตผ่าน Wi-Fi เดียวกัน:`);
  console.log(`   - หน้าหลัก / แคชเชียร์:  http://${localIp}:${PORT}/`);
  console.log(`   - ลิงค์โต๊ะ 1:           http://${localIp}:${PORT}/?table=1`);
  console.log(`   - ลิงค์โต๊ะ 2:           http://${localIp}:${PORT}/?table=2`);
  console.log(`   - ลิงค์โต๊ะ 3:           http://${localIp}:${PORT}/?table=3`);
  console.log(`\n💡 ข้อมูลเข้าสู่ระบบเจ้าของร้าน: owner / sakura2026`);
  console.log(`\n(กด Ctrl + C เพื่อหยุดการทำงานของเซิร์ฟเวอร์)`);
  console.log('================================================================\n');
});
