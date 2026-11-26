'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sendViaIpageRelay } = require('../src/lib/mailer');
test('iPage relay sends authenticated HTTPS email payload', async () => { let req; const result=await sendViaIpageRelay({to:'company@example.com',subject:'MMC OTP',text:'123456'},'https://mail.example.com/send.php','private-test-token',async(url,options)=>{req={url,options};return{ok:true,status:200,json:async()=>({ok:true,provider_accepted:true})};}); assert.equal(req.options.headers.Authorization,'Bearer private-test-token'); assert.deepEqual(JSON.parse(req.options.body),{to:'company@example.com',subject:'MMC OTP',text:'123456'}); assert.equal(result.provider_accepted,true); });
test('iPage relay rejects failed delivery response', async()=>{await assert.rejects(()=>sendViaIpageRelay({to:'company@example.com',subject:'OTP',text:'123456'},'https://mail.example.com/send.php','private-test-token',async()=>({ok:false,status:401,json:async()=>({ok:false,error:'unauthorized'})})),/iPage relay rejected/);});
