import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import url from 'url';

let acftCache = null;
let atisCache = null;
let healthStatus = false;

const clients = new Set();      //acft data clients
const flpClients = new Set();   //flight plan clients

const app = express();
app.use(cors());

const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });

//needed for routing
server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname;

  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.path = pathname; // store path for routing
    wss.emit('connection', ws, request);
  });
});
  //setup the output WebSocket
wss.on('connection', (ws) => {
  if (ws.path === '/api/acft-data') {
    clients.add(ws);
    console.log('ACFT client connected');
    //send initial data if available
    if (acftCache) { 
      ws.send(JSON.stringify(acftCache));
    } else {
      ws.send(JSON.stringify(""));
    }
    //close event handler
    ws.on('close', () => {
      clients.delete(ws);
      console.log('ACFT client disconnected');
    });

  } else if (ws.path === '/api/flight-plans') {
    flpClients.add(ws);
    console.log('Flight Plan client connected');

    if (flightplans.length) ws.send(JSON.stringify(flightplans));
    else ws.send(JSON.stringify(""));

    ws.on('close', () => {
      flpClients.delete(ws);
      console.log('Flight Plan client disconnected');
    });
  } else {
    ws.close(); // unsupported path
  }
});

//ping flightplan clients because of the high intervals between messages
setInterval(() => {
  for (const ws of flpClients) {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }
}, 30000);

// Allow requests 
app.use(cors()); 

//setup inbound WebSocket
function connectUpstream() {
  const socket = new WebSocket('wss://24data.ptfs.app/wss', { perMessageDeflate: false });

  socket.on('open', () => console.log('Upstream WS connected'));
  socket.on('message', handleMessage);

  socket.on('close', () => {
    console.warn('Upstream WS closed, reconnecting in 5s');
    setTimeout(connectUpstream, 5000);
  });

  socket.on('error', (err) => {
    console.error('Upstream WS error', err);
    socket.close();
  });

  return socket;
}

let socket = connectUpstream();
//listen and filter out just the needed data
function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

    if(msg.t ==='ACFT_DATA'){
      acftCache = msg;
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(acftCache));
      }
    } else if (msg.t ==='ATIS') {
      pullATIS();
    } else if (msg.t === 'FLIGHT_PLAN') {
      handleFlightPlan(msg.d);
    }
}

let flightplans = [];

async function handleFlightPlan(data) {
  flightplans.push(data);

  for (let i = flightplans.length - 1; i >= 0; i--) {
    if (!acftCache?.d?.hasOwnProperty(flightplans[i].realcallsign)) {
      flightplans.splice(i, 1);
    }
  }

  //send updated flight plans
  for (const ws of flpClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(flightplans));
  }
}

let controllersCache = null;
//pull the data for active controllers
async function pullControllers() {
  try {
    const res = await fetch("https://24data.ptfs.app/controllers");
    controllersCache = await res.json();
    healthStatus = true;
  } catch (err) {
    healthStatus = false;
    console.error("Error fetching controllers:", err);
  }
}

async function pullATIS() {
  try {
    const res = await fetch("https://24data.ptfs.app/atis");
    atisCache = await res.json();
    healthStatus = true;
  } catch (err) {
    healthStatus = false;
    console.error("Error fetching ATIS:", err);
  }
}

setInterval(pullControllers, 6000);
pullControllers();

setInterval(pullATIS, 30000);
pullATIS();

app.get("/api/controllers", (req, res) => {
  res.json(controllersCache || []);
});

app.get("/api/datahealth", (req, res) => {
  res.json(healthStatus || []);
});

app.get("/api/clientcount", (req, res) => {
  res.json(clients.size || 0);
});

app.get("/api/atis", (req, res) => {
  //get the airport parameter value
  const req_airport = req.query.airport;
  //find the requested value
  const result = atisCache?.find(item => item.airport === req_airport);
  //send it back
  res.json(result || []);
});

app.get("/api/teapot", (req, res) => {
  res.status(418).send("<html><body><h1>I'm a teapot</h1></body></html>");
});

server.listen(8443, () => console.log("Server running on port 8443"));
