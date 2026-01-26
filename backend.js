const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const WebSocket = require('ws');
const { URL } = require("url");
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database("/home/drkocourek/24api/stats/stats.sqlite");

let acftCache;

const app = express();

// Allow requests
app.use(cors());

//setup websocket
const socket = new WebSocket('wss://24data.ptfs.app/wss');
socket.addEventListener('open', event =>{
  console.log("Websocket to 24data established successfully!");
});



//listen and filter the needed data
socket.addEventListener('message', raw => {
    const text = raw.data;
    let msg;
  try {
    msg = JSON.parse(text);
  } catch (err) {
    console.error("Invalid JSON:", err);
    return;
  }
  //console.log("Data type: ", msg.t);

  if (msg.t != "ACFT_DATA") return;
  acftCache = msg;
});
// Check if websocket was closed
socket.addEventListener('close', event => {
  console.log('WebSocket connection closed:', event.code, event.reason);
});
// check for error while usin websocket
socket.addEventListener('error', error => {
  console.error('WebSocket error:', error);
});

//setup the output websocket



let healthStatus;

let flightplans = [];

async function handleFlightPlan(data){
  let index = flightplans.length;
  flightplans[index] = data;
  //console.log(flightplans[index].d.arriving);
  
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

app.get("/api/atis", (req, res) => {
  //get the airport parameter value
  let req_airport = req.query.airport
  //find the requested value
  let final_return = atisCache.find(item => item.airport === req_airport);
  db.run(
  "UPDATE airports SET count = count + 1 WHERE id = ?",
  [23],
  function(err) {
    if (err) {
      console.error(err);
    } else {
      console.log(`Row updated successfully`);
    }
  }
);
  //console.log(final_return);
    db.all("SELECT * FROM airports WHERE name = ?", [req.query.airport], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "Database error" });
    } else {
        if (rows == []) {
          
        } else {
          db.run(
            "UPDATE airports SET count = count + 1 WHERE name = ?",[req.query.airport],
            function(err) {
              if (err) {
                console.error(err);
              } else {
                console.log(`Row updated successfully`);
              }
            });
        }
    }})
  //send it back
  res.json(final_return || []);
});

app.get("/api/teapot", (req, res) => {
  res.status(418);
  res.send("<html><body><h1>I'm a teapot</h1></body><html>");
});


app.listen(3000, () => console.log("Server running on port 3000"));
