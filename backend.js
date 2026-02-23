import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import url from 'url';


import { createRequire } from "module";
const require = createRequire(import.meta.url);

require('dotenv').config();

const initSqlJs = require("sql.js");
const fs = require("fs");
const path = require("path");

const DB_PATH = "/home/drkocourek/24api/stats/stats.sqlite";

let db;

async function openDb() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  return db;
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

export default {
  openDb,
  saveDb,
  getDb: () => db
};

//const axios = require('axios');

//const db = require('./db');

let acftCache = null;
let atisCache = null;
let healthStatus = false;

const clients = new Set();      //acft data clients
const generalClients = new Set();   //flight plan clients



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

  } else if (ws.path === '/api/general') {
    generalClients.add(ws);
    console.log('General WS client connected');

    if (flightplans.length) ws.send(JSON.stringify({type: "FLIGHT_PLAN", data: flightplans}));
    else ws.send(JSON.stringify(""));
    if(atisCache) ws.send(JSON.stringify({type: "ATIS", data: atisCache}));
    else ws.send(JSON.stringify(""));
    ws.on('close', () => {
      generalClients.delete(ws);
      console.log('General WS client disconnected');
    });
  } else {
    ws.close(); // unsupported path
  }
});

//ping flightplan clients because of the high intervals between messages
setInterval(() => {
  for (const ws of generalClients) {
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
      sendATIS();
    } else if (msg.t === 'FLIGHT_PLAN') {
      handleFlightPlan(msg.d);
    }
}

async function sendATIS() {
  for (const ws of generalClients) {
    if (ws.readyState === WebSocket.OPEN){ 
      ws.send(JSON.stringify({
        type: "ATIS",
        data: atisCache,
      }));
    } 
  }
}


let flightplans = [];
let flightplan_timestamps = [];

async function syncflp(){
  try {
  const res = await fetch("https://loadbalancer.drkocourek.workers.dev");
  const rcv_url = await res.json();
  const json_fetch = await fetch(rcv_url + "/api/flpsync");
  const final_json = await json_fetch.json();
  flightplans = final_json.flp;
  flightplan_timestamps = final_json.times;
  } catch(e) {
    console.error(e);
  }
}
syncflp();


async function handleFlightPlan(data) {
  flightplans.push(data);
  flightplan_timestamps.push(Date.now());

  for (let i = 0; i <= flightplans.length; i++) {
    if (Math.floor((Date.now() - flightplan_timestamps[i]) / 60000) > 100){ //keep flightplans for at most 100 minutes

      flightplans.splice(i, 1);
      flightplan_timestamps.splice(i, 1);
      i--;
    }
  }
  for (let i = 0; i < flightplans.length; i++) {
    const name = flightplans[i].robloxName;

    // Check if this name appears later in the array
    const duplicateIndex = flightplans.findIndex((fp, idx) => fp.robloxName === name && idx > i);

    if (duplicateIndex !== -1) {
      // Remove the current (lower index) one
      flightplans.splice(i, 1);
      flightplan_timestamps.splice(i, 1);
      i--; // stay on the same index since we removed an element
    }
  }

  //send updated flight plans
  for (const ws of generalClients) {
    if (ws.readyState === WebSocket.OPEN){ 
      ws.send(JSON.stringify({
        type: "FLIGHT_PLAN",
        data: flightplans
      }));
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


setInterval(async () => {
  db.run("INSERT INTO WS VALUES(" + Date.now() + "," + clients.size + ");",             
  function(err) {
    if (err) {
      console.error(err);
    } else {
    }
  });
}, 60000);

app.get("/api/flpsync", (req, res) => {
  res.json({
    flp: flightplans,
    times: flightplan_timestamps
  } || []);
});


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

/*

//TBD later
//discord login routes

//this path shouldnt be used to save bandwidth and requests on the loadbalancer
app.get("/api/auth/discord/login", (req, res) => {
  const url = "https://discord.com/oauth2/authorize?client_id=1475127263451152414&response_type=code&redirect_uri=https%3A%2F%2Fauth.drkocourek.stream%2F&scope=identify"
  res.redirect(url);
});


var options = {
  host: 'www.host.com',
  path: '/',
  port: '443',
  method: 'POST'
};

let callback = function(response) {
  var str = ''
  response.on('data', function (chunk) {
    str += chunk;
  });

  response.on('end', function () {
    console.log(str);
  });
}

app.get("/api/auth/discord/callback", async (req, res) => {
  if (!req.query.code) {
    res.status(400).send("<html><body><h1>Error 400. No oauth2 code provided</h1></body></html>")
  }

  const { code } = req.query
  //get the discord access token
  const params = new URLSearchParams();
  params.append("client_id", process.env.DISCORD_CLIENT_ID);
  params.append("client_secret", process.env.DISCORD_CLIENT_SECRET);
  params.append("grant_type", "authorization_code");
  params.append("code", code);
  params.append("redirect_uri", process.env.DISCORD_REDIRECT_URI);
  //get the user data
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
  }

  const response = await axios.post('https://discord.com/api/oauth2/token', params.toString(),
    {    
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    }
    });
  const getUserResponse = await axios.get('https://discord.com/api/users/@me', {
    headers: {
      Authorization: `Bearer ${response.data.access_token}`,
      ...headers
    }
  });

  const {id, username, avatar} = getUserResponse.data;

  const UserExists = await db('users').where({discordId: id}).first();
  if (UserExists) {
    await db('users').where({discordId: id}).update({username, avatar});
  } else {
    await db('users').where({discordId: id, username, avatar});
  }

  res.json(getUserResponse.data);
  });*/


server.listen(8443, () => console.log("Server running on port 8443"));
