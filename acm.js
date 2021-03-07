const http = require("http");
const https = require("https");
const querystring = require("querystring");
const fs = require("fs");
const path = require("path");
const URL = require("url");
const os = require("os");
const mqtt = require('mqtt');
const bufferFrom = require('buffer-from')

module.exports = function (RED) {
  function acm(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    node.strategy = JSON.parse(config.strategy);

    // preconfigurations
    switch (node.strategy.name) {
      case "Light": node.state = false; break;
      case "FSM":
      node.fsm = require("./FSM.js").buildFSM(node.strategy.configuration);
      break;
      case "SocketBefore": node.plugState = false; break;
      case "Monitor":
      node.strategy.configuration.forEach(conf =>{
        if(conf.name === "mqttserver"){
          node.brokerAddress = conf.value;
        }
        if(conf.name === "mqtttopic"){
          node.topic = conf.value;
        }
      });

      console.log(node.brokerAddress);
      console.log(node.topic);

      node.client = mqtt.connect(node.brokerAddress);
      node.status({ fill: "red", shape: "ring", text: "MQTT broker address invalid" });

      node.client.on('connect', function () {
        node.brokerOK = true
        node.status({ fill: "green", shape: "dot", text: "MQTT OK" });
      });
      node.client.on("error", function(err){
        node.brokerOK = false;
        node.status({ fill: "red", shape: "ring", text: "MQTT error" });
        console.log("error connecting to MQTT");
        console.log(err);
      });

      break;
      case "AgendaLockACSCAAC":
      node.authsettings = {};
      node.authsettings.access_token = null;
      break;
      case "AgendaLockACSCAAC-disabled":
      // step 4 will likely require CAAC auth
      // read client ids from a known file, hopefully
      // polling method for later
      node.openidPoll = function (device_code) {
        let tokenurl = URL.parse("https://dep-auth.evidian.com/form/oidc/token");
        let tokenbody = querystring.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: device_code,
          client_id: node.authsettings.client_id,
          client_secret: node.authsettings.client_secret
        });
        let tokenoptions = {
          protocol: tokenurl.protocol,
          hostname: tokenurl.hostname,
          port: tokenurl.port,
          path: tokenurl.path,
          method: "POST",
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': tokenbody.length
          }
        };
        let tokenreq = https.request(tokenoptions, (tokenres) => {
          let tokenbody = "";
          tokenres.setEncoding('utf8');
          tokenres.on('data', (chunk) => {
            tokenbody += chunk;
          });
          tokenres.on('end', () => {
            try {
              let result = JSON.parse(tokenbody);
              console.log("openid token result:");
              console.log(result);

              // save token to auth settings and save file
              node.authsettings.access_token = result.access_token;
              node.authsettings.id_token = result.id_token;
              node.authsettings.expires_at = new Date().getTime() / 1000 + result.expires_in;

              fs.writeFileSync(RED.settings.userDir + path.sep + "acm-evidian-auth.json", JSON.stringify(node.authsettings));

              node.status({ fill: "green", shape: "dot", text: "Connected OK" });
            } catch (e) {
              console.log("openid parsing error , http code " + tokenres.statusCode);
              console.log(e);
              // cant parse response, assume it's a 403 and keep pollin
              setTimeout(() => node.openidPoll(device_code), 5000);
            }
          });
        });
        tokenreq.write(tokenbody);
        tokenreq.end();
      }
      node.authsettings = JSON.parse(fs.readFileSync(RED.settings.userDir + path.sep + "acm-evidian-auth.json"));
      console.log("Using Evidian openid settings:")
      console.log(node.authsettings);
      if (!node.authsettings.access_token || node.authsettings.expires_at < (new Date().getTime / 1000)) {
        // cant use a cool library because the evidian implementation is broke
        let devcodeurl = URL.parse("https://dep-auth.evidian.com/form/oidc/devicecode");
        let devcodebody = querystring.stringify({
          client_id: node.authsettings.client_id,
          scope: "email openid",
          device_code_validity_seconds: 300,
          myDeviceId: os.hostname(),
          myDeviceSerialNum: "s" + os.hostname()
        });
        let devcodeoptions = {
          protocol: devcodeurl.protocol,
          hostname: devcodeurl.hostname,
          port: devcodeurl.port,
          path: devcodeurl.path,
          method: "POST",
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': devcodebody.length
          }
        };
        let devcodereq = https.request(devcodeoptions, (devcoderes) => {
          let devcodebody = "";
          devcoderes.setEncoding('utf8');
          devcoderes.on('data', (chunk) => {
            devcodebody += chunk;
          });
          devcoderes.on('end', () => {
            console.log(devcoderes.statusCode);
            //console.log(devcodebody);
            let result = JSON.parse(devcodebody);
            console.log("openid auth device code result:");
            console.log(result);
            // communicate code to user through node status
            node.status({ fill: "red", shape: "ring", text: "Code: " + result.user_code });

            // now start polling for accept
            setTimeout(() => node.openidPoll(result.device_code), 5000);
          });
        });
        devcodereq.write(devcodebody);
        devcodereq.end();
      } else {
        node.status({ fill: "green", shape: "dot", text: "Connected OK" });
      }
      case "AgendaLockACS":
      case "TimeLockACS":
      case "SimpleLockACS":
      break;
      default: break;
    }
    node.outputCount = node.strategy.outputs || 1;

    // main dumb hardcoded functions
    node.on('input', function (msg) {
      let ret = false;
      let singleout = false;
      let skipsyncsend = false;
      let retismsg = false;
      // another epic backwards compatibility trick
      // had to update sync to actually send the whole msg not just the payload
      // so we restore the old behaviour in the payload field and expose payloadRaw for full msg aware ACMs
      // ! msg.payloadUnit = msg.payload;
      msg.payloadRaw = msg.payload;
      msg.payload = msg.payload.map(pl => pl ? pl.payload : null);
      msg.payloadTab = msg.payloadRaw.map(pl => pl ? pl.map(p => p ? (p.topic ? p.topic+"_"+p.payload : p.payload) : null):null);

      switch (node.strategy.name) {
        case "Sum":
        for (let index in msg.payload) {
          ret += msg.payload[index];
        }
        break;


        case "DoorsConflictACM":
        //in this case, we have a direct Conflict (just one actuator : Door's commander)
        //it can happen in the same time that two apps try to manipulate the doors differently
        //we handled this conflict with a simple priority logic : Passenger < Dashboard < Base Station

        console.log("\n*************************** DOORS Conflict Manager ***************************\n");

        let data = msg.payloadRaw;
        let msgIsFromBase = false
        let msgIsFromDash = false
        let msgFromPass = ""

        //Iterate through data received
        for (let index in data) {
          for(let i in msg.payloadRaw[index])
          {
            if(msg.payloadRaw[index][i] != undefined){

              if(msg.payloadRaw[index][i].acmFlowName == "Base"){

                //the message received is from the Base Station App
                msgIsFromBase = true
                msgFromBase = msg.payloadRaw[index][i].payload
                console.log("Command "+msg.payloadRaw[index][i].payload+ ", received from the Base Station\n")

                //no need to continue iterating because the base has the biggest priority
                break;

              }
              else if(msg.payloadRaw[index][i].acmFlowName == "Dashboard"){

                //the message received is from the Dashboard App
                msgIsFromDash = true
                msgFromDash = msg.payloadRaw[index][i].payload
                console.log("Command "+msg.payloadRaw[index][i].payload+ ", received from the Dashboard\n")

              }
              else {

                //the message received is from the Passenger App
                msgFromPass = msg.payloadRaw[index][i].payload
                console.log("Command "+msg.payloadRaw[index][i].payload+ ", received from the Passenger\n")

              }
            }
          }

          //if the message is from the base, we need to break from the from the first loop also
          if(msgIsFromBase)
          break;

        }

        //Return the right command and handle the conflict
        if(msgIsFromBase)
        ret = msgFromBase

        else if(msgIsFromDash)
        ret = msgFromDash

        else
        ret = msgFromPass

        console.log("Command Transmitted : "+ret+"\n");

        break;

        case "SpeedConflict":

        //In this case, we have an indirect Conflict (two actuators : Accelerator and the brakes)
        //we shouldn't be able to accelerate and to pull the brakes at the same time
        //we are expecting to receive two commands (accelerate and stop)
        //whenever we get the two commands at the sime time, we only let pass the stop command to handle the conflict

        let trainMustBeStopped = false

        //this just a variable to detect if the conflict have occured or not
        let count = 0

        //iterate through data received
        for (let index in msg.payloadRaw) {

          for(let i in msg.payloadRaw[index])
          {
            if(msg.payloadRaw[index][i] != undefined){
              if(msg.payloadRaw[index][i].payload == "stop"){

                //stop command received
                trainMustBeStopped = true
                count++

              }
              else {
                count++
              }
            }
          }

        }

        if(count > 1)
          console.log("\n********************* Speed Conflict Occured *********************\n")

        //handle the conflict and transmit the right command
        if(trainMustBeStopped){
          //stop command must be transmitted in this case
          ret = "stop"
          console.log("Command Stop Transmitted\n")

        }


        else{
          //we didn't receive the stop command, so the right behaviour is to transmit the acceleration command
          ret = "accelerate"
          console.log("Command Accelerate Transmitted\n")
        }


        break;

        case "SoundMicrophoneACM":

        //in this case we have a direct conflict, the two apps act on the same physical
        //property which is the sound
        //we are expecting two vocal messages from two apps (base station and passenger)
        //we handled this conflict by prioritizing the base's vocal message

        let soundData = msg.payloadRaw;
        let soundMsgIsFromBase = false;
        let soundMsgFromBase;
        let soundMsgFromPassenger;

        //Iterate through data received
        for (let index in soundData) {
          for(let i in msg.payloadRaw[index])
          {
            if(msg.payloadRaw[index][i] != undefined){
              if(msg.payloadRaw[index][i].acmFlowName == "Base"){

                //Sound message is received from the Base Station App
                console.log("Sound Message received from : "+msg.payloadRaw[index][i].acmFlowName)
                //get the sound message as a buffer
                soundMsgFromBase = bufferFrom(msg.payloadRaw[index][i].payload.data)
                soundMsgIsFromBase = true;
              }
              else{

                //Sound message is received from the Passenger App
                console.log(msg.payloadRaw[index][i].acmFlowName)
                //get the sound message as a buffer
                soundMsgFromPassenger = bufferFrom(msg.payloadRaw[index][i].payload.data)
              }
            }
          }
        }

        //Trasnmit the right sound message to handle the conflict
        if(soundMsgIsFromBase){

          ret = soundMsgFromBase
          console.log("Base Station App Sound Transmitted !!!!\n");

        }
        else  {

          ret = soundMsgFromPassenger
          console.log("Passenger App Sound Transmitted !!!!! \n");

        }

        break;

        case "SoundFileACM":

        //This is an example just for our demo as its not simple to demonstrate
        //the sound conflict resolution using microphones on the same laptop
        //while the interviews are online

        let soundFileData = msg.payloadRaw;
        let soundMsgIsFromFirstFlow = false;
        let soundMsgFromFirstFlow;
        let soundMsgFromSecondFlow;

        //Iterate through data received
        for (let index in soundFileData) {
          for(let i in msg.payloadRaw[index])
          {
            if(msg.payloadRaw[index][i] != undefined){

              if(msg.payloadRaw[index][i].acmFlowName == "Sound 1"){

                console.log(msg.payloadRaw[index][i].acmFlowName)

                //store the sound message as a buffer
                soundMsgFromFirstFlow = bufferFrom(msg.payloadRaw[index][i].payload.data);

                //This is the flow that we are prioritising in our demo
                soundMsgIsFromFirstFlow = true;
              }
              else {

                console.log(msg.payloadRaw[index][i].acmFlowName)

                soundMsgFromSecondFlow = bufferFrom(msg.payloadRaw[index][i].payload.data);

              }
            }
          }
        }

        //Send the prioritised Sound message and handle the conflict
        if(soundMsgIsFromFirstFlow){

          ret =soundMsgFromFirstFlow
          console.log("First flow Sound Transmitted \n");

        }
        else  {

          ret = soundMsgFromSecondFlow
          console.log("Second flow Sound Transmitted \n");

        }

        break;

        case "OR":
        ret = false;

        for (let index  in msg.payloadRaw) {
          for(let i in msg.payloadRaw[index])
          {
            if(msg.payloadRaw[index][i] != undefined){
              ret = ret || (msg.payloadRaw[index][i].payload);
              console.log(ret);
            }
          }
        }
        break;

        case "AND":
        ret = true;

        for (let index  in msg.payloadRaw) {
          for(let i in msg.payloadRaw[index])
          {
            if(msg.payloadRaw[index][i] != undefined){
              ret = ret && (msg.payloadRaw[index][i].payload);
              console.log(ret);
            }
          }
        }
        break;

        case "Average":
        for (let index in msg.payloadTab) {
          ret += msg.payloadTab[index];
        }
        ret /= msg.payloadTab.length;
        break;
        case "Min":
        ret = Math.min.apply(null, msg.payloadTab);
        retismsg = true;
        break;
        case "Max":
        ret = Math.max.apply(null, msg.payload);
        break;
        case "Random":
        ret = msg.payload[Math.floor(Math.random() * msg.payload.length)];
        break;
        case "Light":
        node.state = !node.state;
        ret = node.state;
        break;
        case "LightRGB":
        node.state = !node.state;
        ret = node.state ? "rgb(255,255,255)" : "rgb(0, 0, 0)";
        break;
        case "FSM":
        // the ACM itself should do the logic tweaking to send payloads not the generic case
        // what I wrote at the bottom was carefully written to not break backwards compatibility with existing ACMs

        let wret = node.fsm.input(msg.payloadTab)
        console.log("outputs")
        console.log(wret)

        let newret = [];
        for (let i = 0; i < node.outputCount; i++) {
          if(wret[i]!=undefined){
            newret[i] = {
              payload: wret[i]
            };
          }
        }
        ret = newret;
        //console.log(newret)
        break;
        case "SocketBefore":
        // turn socket (output 2) on when it is told to turn on or when the light is told to turn on
        if (msg.payload[1] !== null) node.plugState = msg.payload[1];
        ret = [{ payload: msg.payload[0] || "OFF" }, { payload: (node.plugState === "ON" || msg.payload[0] === "ON") ? "ON" : "OFF" }];
        if (node.strategy.delay) {
          setTimeout(() => { node.send(ret); }, node.strategy.delay);
        }
        break;
        case "PassThrough":
        ret = msg.payload.map(raw => { return { payload: raw } });
        break;
        case "Broadcast":
        ret = msg.payload.find(t => t);
        singleout = true;
        break;
        case "incColor": {
          // take first non null message and process it
          let msgToProcess = msg.payload.find(t => t !== null);
          try {
            on = parseInt(msgToProcess.on);
            val = parseInt(msgToProcess.val);
            if (on === 0) {
              ret = { 'on': 1, 'val': (val + 30) % 360 }
            } else {
              ret = msgToProcess
            }
          } catch (error) {
            ret = msgToProcess;
          }
          break;
        }
        case "onOffIncColor": {
          // take first non null message and process it
          let msgToProcess = msg.payload.find(t => t !== null);
          try {
            on = parseInt(msgToProcess.on);
            val = parseInt(msgToProcess.val);
            if (val === -1) val = 0;
            if (on === 0) {
              ret = { 'on': 0, 'val': val };
            } else if (on === 1) {
              ret = { 'on': 1, 'val': (val + 60) % 360 }
            }
          } catch (error) {
            ret = msgToProcess;
          }
          break;
        }
        case "SodiumColor": {
          // take first non null message and process it
          let msgToProcess = msg.payload.find(t => t !== null);
          try {
            on = parseInt(msgToProcess.on);
            val = parseInt(msgToProcess.val);
            if (val === -1) val = 0;
            if (on === 0) {
              ret = { 'on': 0, 'val': 25 };
            } else if (on === 1) {
              ret = { 'on': 1, 'val': 25 }
            }
          } catch (error) {
            ret = msgToProcess;
          }
          break;
        }
        case "Monitor":
        if (node.brokerOK) {
          node.client.publish(node.topic, JSON.stringify(msg.payload));
        }
        ret = msg.payload.map(raw => { return { payload: raw } });
        break;

        /****
        * Hackathon
        ****/
        case "SimpleLockACS": {
          // basically a passthrough
          ret = msg.payload.find(t => t !== null);
          retismsg = true;
          break;
        }
        case "TimeLockACS": {
          // only allow through if its office hours
          let start = new Date(), end = new Date(), now = new Date();
          start.setHours(8);
          start.setMinutes(0);
          end.setHours(18);
          end.setMinutes(0);
          if (start < now && now < end) {
            ret = msg.payloadRaw.find(t => t !== null);
            retismsg = true;
          } else {
            //skipsyncsend = true;
            ret = "LED:255:0:0\n";
          }
          break;
        }
        // CAAC just adds a header to the request
        case "AgendaLockACS": {
          skipsyncsend = true;
          let msgToProcess = msg.payloadRaw.find(t => t !== null);

          let AGENDA_URL = node.strategy.agendaip || "172.17.0.1";
          let scheduleurl = URL.parse("http://" + AGENDA_URL + "/schedules/now");
          let scheduleoptions = {
            protocol: scheduleurl.protocol,
            hostname: scheduleurl.hostname,
            port: scheduleurl.port,
            path: scheduleurl.path,
            method: "GET"
          };
          let schedulereq = http.request(scheduleoptions, (scheduleres) => {
            let schedulebody = "";
            scheduleres.setEncoding('utf8');
            scheduleres.on('data', (chunk) => {
              schedulebody += chunk;
            });
            scheduleres.on('end', () => {
              let result = JSON.parse(schedulebody);
              if (result.status === "auth error") {
                node.status({ fill: "red", shape: "ring", text: "Auth error" });
              } else {
                let ok = false;
                for (let schedidx in result) {
                  let sched = result[schedidx];
                  if (sched.body.indexOf(msgToProcess.userid) > -1) {
                    ok = true;
                    node.completeOutput(msg, msgToProcess, singleout, true);
                  }
                }
                if (!ok) {
                  msgToProcess.payload = "LED:255:0:0\n";
                  node.completeOutput(msg, msgToProcess, singleout, true);
                }
                node.status({ fill: "green", shape: "dot", text: "Request OK" });
              }
            });
          });
          schedulereq.on("error", (err) => { console.error("ACM AgendaLockACS error in request"); console.error(err); node.error("ACM AgendaLockACS error in request "); node.error(err); });
          schedulereq.end();
          break;
        }
        case "AgendaLockACSCAAC": {
          skipsyncsend = true;
          let msgToProcess = msg.payloadRaw.find(t => t !== null);

          let AGENDA_URL = node.strategy.agendaip || "172.17.0.1";
          let scheduleurl = URL.parse("http://" + AGENDA_URL + "/schedules/now");
          let scheduleoptions = {
            protocol: scheduleurl.protocol,
            hostname: scheduleurl.hostname,
            port: scheduleurl.port,
            path: scheduleurl.path,
            method: "GET",
            headers: {
              Authorization: "Bearer " + (node.authsettings.access_token || node.strategy.access_token)
            }
          };
          let schedulereq = http.request(scheduleoptions, (scheduleres) => {
            let schedulebody = "";
            scheduleres.setEncoding('utf8');
            scheduleres.on('data', (chunk) => {
              schedulebody += chunk;
            });
            scheduleres.on('end', () => {
              let result = JSON.parse(schedulebody);
              if (result.status === "auth error") {
                node.status({ fill: "red", shape: "ring", text: "Request failed (CAAC)" });
              } else {
                let ok = false;
                for (let schedidx in result) {
                  let sched = result[schedidx];
                  if (sched.body.indexOf(msgToProcess.userid) > -1) {
                    ok = true;
                    node.completeOutput(msg, msgToProcess, singleout, true);
                  }
                }
                if (!ok) {
                  msgToProcess.payload = "LED:255:0:0\n";
                  node.completeOutput(msg, msgToProcess, singleout, true);
                }
                node.status({ fill: "green", shape: "dot", text: "Request OK (CAAC)" });
              }
            });
          });
          schedulereq.on("error", (err) => { console.error("ACM AgendaLockACS error in request"); console.error(err); node.error("ACM AgendaLockACS error in request "); node.error(err); node.status({ fill: "red", shape: "ring", text: "Request error" }); });
          schedulereq.end();
          break;
        }
        default:
        console.log("dumb ACM unknown strat name " + node.strategy.name);
        skipsyncsend = true;
        break;
      }

      if (!skipsyncsend) {
        node.completeOutput(msg, ret, singleout, retismsg);
      }
    });

    node.completeOutput = function (msg, ret, singleout, retismsg) {
      // multiple outputs
      if (node.outputCount > 1) {
        // expand single output in array
        if (!Array.isArray(ret) || singleout) {
          let newret = [];
          for (let i = 0; i < node.outputCount; i++) {
            if (retismsg) {
              newret.push(ret);
            } else {
              newret.push({
                payload: ret
              });
            }
          }
          node.send(newret);
        } else {
          // just send the array
          node.send(ret);
        }
      } else {
        // single output mode
        if (retismsg) {
          node.send(ret);
        } else {
          msg.payload = ret;
          node.send(msg);
        }
      }
    }

    /*let serverWrapperCallback = function (req, res) {
    let code = req.query.code;
    console.log("code:" + code);

    let url = require("url").parse("https://login.microsoftonline.com/common/oauth2/v2.0/token");

    let postData = querystring.stringify({
    client_id: CLIENT_ID,
    client_secret: APP_SECRET,
    code: code,
    redirect_uri: "http://localhost:8010/callback",
    grant_type: "authorization_code"
  });

  let options = {
  protocol: url.protocol,
  hostname: url.hostname,
  port: url.port,
  path: url.path,
  method: "POST",
  headers: {
  'Content-Type': 'application/x-www-form-urlencoded',
  'Content-Length': postData.length
}
};

let codereq = https.request(options, (coderes) => {
let codebody = "";
coderes.setEncoding('utf8');
coderes.on('data', (chunk) => {
codebody += chunk;
});
coderes.on('end', () => {
console.log(JSON.parse(codebody));
fs.writeFileSync("ms-auth.json", codebody);
res.end("<html><head></head><body><h1>You can close this window.</h1></body></html>");
process.exit();
});
});
codereq.write(postData);
codereq.end();
};
Object.defineProperty(serverWrapperCallback, "name",
{
enumerable: true,
configurable: true,
writable: true,
value: "/acm-httpin-" + config.id + "/"
}
);

// Register the route for the frontend
RED.httpAdmin.get("/acm-httpin-" + config.id + "/", RED.auth.needsPermission('read'), serverWrapperCallback);

node.on('close', function (done) {
// Delete the old route
// Because Express (the framework used for NR's WS) doesn't allow to overwrite an existing route
// And this caused issues with old references being carried over
let routes = RED.httpAdmin._router.stack;
routes.forEach(removeMiddlewares);
function removeMiddlewares(route, i, routes) {
if (route.name === "/acm-httpin-" + config.id + "/") {
routes.splice(i, 1);
}
if (route.route) {
route.route.stack.forEach(removeMiddlewares);
}
}
done();
});*/
}
RED.nodes.registerType("acm", acm);
}
