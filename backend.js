import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import url from 'url';

let acftCache;
let atisCache;
//keep track of connected users
const clients = new Set();
const flpClients = new Set();


const app = express();

const server = http.createServer(app);

const wss = new WebSocketServer({
  server,
  path: '/api/acft-data',
});
const wsp = new WebSocketServer({
  server,
  path: '/api/flight-plans',
});

//setup the output acft data WebSocket
wss.on('connection', (ws) => {
  clients.add(ws); 
  console.log('New client connected');
  // Send the initial data to the client
  if(acftCache) {
    ws.send(JSON.stringify(acftCache));
  } else {
    ws.send(JSON.stringify(""));
  }
  // Close event handler
  ws.on('close', () => {
    console.log('Client disconnected');
    clients.delete(ws);
  });
});
//the flightplan websocket
wsp.on('connection', (ws) => {
  flpClients.add(ws); 
  console.log('New client connected');
  // Send the initial data to the client
  if(flightplans) {
    ws.send(JSON.stringify(flightplans));
  } else {
    ws.send(JSON.stringify(""));
  }
  // Close event handler
  ws.on('close', () => {
    console.log('Client disconnected');
    flpClients.delete(ws);
  });
});
//handle pings on flightplans websocket only cuz of data frequency being so low
setInterval(() => {
  for (const ws of flpClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }
}, 30000);


// Allow requests
app.use(cors());
//setup WebSocket
function connectUpstream() {
  const socket = new WebSocket('wss://24data.ptfs.app/wss');

  socket.on('open', () => {
    console.log('Upstream WS connected');
  });

  socket.on('message', handleMessage);

  socket.on('close', () => {
    console.warn('Upstream WS closed, reconnecting in 5s');
    setTimeout(connectUpstream, 5000);
  });

  socket.on('error', err => {
    console.error('Upstream WS error', err);
    socket.close();
  });

  return socket;
}

let socket = connectUpstream();
//listen and filter just the needed data
  function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === 'ACFT_DATA') {
      acftCache = msg;
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(acftCache));
        }
      }
    } else if (msg.t === 'ATIS') {
      pullATIS();
    } else if (msg.t === 'FLIGHT_PLAN') {
      handleFlightPlan(msg.d);
    }
  }




let healthStatus;

let flightplans = [];

async function handleFlightPlan(data){
    flightplans.push(data);

  for (let i = flightplans.length - 1; i >= 0; i--) {
    if (!acftCache.d.hasOwnProperty(flightplans[i].realcallsign)) {
      flightplans.splice(i, 1);
    }
  }
  //send of the updated flightplans
  for (const client of flpClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(flightplans));        
    }
  }
}

let controllersCache = null;
//pull the data for active controllers
async function pullControllers() {
  try {
    const res = await fetch("https://24data.ptfs.app/controllers");
    controllersCache = await res.json();
    healthStatus = true;
    //console.log("Updated controllers cache");
  } catch (err) {
    healthStatus = false
    console.error("An error occured when trying to receive data: ", err);
  }
}


async function pullATIS() {
  try{
    const res = await fetch("https://24data.ptfs.app/atis");
    atisCache = await res.json();
    healthStatus = true;
  } catch(err){
    healthStatus = false;
    console.error("An error occured when trying to receive data: ", err);
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
  let req_airport = req.query.airport
  //find the requested value
  let final_return = atisCache.find(item => item.airport === req_airport);
  //console.log(final_return);
  //send it back
  res.json(final_return || []);
});

app.get("/api/teapot", (req, res) => {
  res.status(418);
  res.send("<html><body><h1>I'm a teapot</h1></body><html>");
});


server.listen(8443, () => console.log("Server running on port 8443"));