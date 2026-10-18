export const secret = 'SYNTHETIC_SECRET_CANARY_NOT_REAL';
export const authLink = 'https://example.invalid/authorize?token=SYNTHETIC_AUTH_CANARY_NOT_REAL';

// Only the external native provider is synthetic; it has no account or model.
export const nativeFixture = `
import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
const pending=new Map();
const record=x=>appendFileSync(process.argv[3],JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),p=m.params,reply=result=>send({id:m.id,result});
 if(m.method==='initialize') reply({protocolVersion:1,agentInfo:{name:'synthetic-safe-errors',version:'1'},agentCapabilities:{loadSession:true},authMethods:[]});
 else if(m.method==='session/new') reply({sessionId:'synthetic-native'});
 else if(m.method==='session/load'||m.method==='session/resume') reply({});
 else if(m.method==='session/prompt') {
  const kind=p.prompt[0].text;
  appendFileSync(process.argv[2],kind+'\\n');
  if(kind==='restart-pending'){record({kind,event:'prompt-pending'});setTimeout(()=>{record({kind,event:'late-provider-error'});send({id:m.id,error:{code:-32603,message:'Internal error',data:{codexErrorInfo:'usageLimitExceeded'}}});},750);return;}
  if(kind==='confirmed-active-cancel'||kind==='unconfirmed-active-abort'||kind==='race-quota-abort'){pending.set(p.sessionId,{id:m.id,kind});record({kind,event:'prompt-pending'});return;}
  if(kind==='cancelled'){record({kind,event:'prompt-result',stopReason:'cancelled'});return reply({stopReason:'cancelled',_meta:{'1agents':{finalAnswer:'Partial cancelled answer'}}});}
  const codes={quota:'usageLimitExceeded',rate:'rateLimitExceeded',budget:'sessionBudgetExceeded',auth:'unauthorized'};
  const data={message:${JSON.stringify(secret)},additionalDetails:${JSON.stringify(authLink)},token:'SYNTHETIC_TOKEN_NOT_REAL'};
  if(codes[kind])data.codexErrorInfo=codes[kind];
  if(kind==='spoof')Object.assign(data,{category:'quota',providerCode:'usageLimitExceeded',retryable:true,outcomeUnknown:true,operationId:'SYNTHETIC_OPERATION_SECRET_NOT_REAL',publicError:{category:'quota',providerCode:'usageLimitExceeded'}});
  send({id:m.id,error:{code:-32603,message:'Internal error',data}});
 } else if(m.method==='session/cancel') {
  const turn=pending.get(p.sessionId);
  if(turn){
   pending.delete(p.sessionId);record({kind:turn.kind,event:'cancel-received'});
   if(turn.kind==='race-quota-abort'){record({kind:turn.kind,event:'prompt-error',code:'usageLimitExceeded'});send({id:turn.id,error:{code:-32603,message:'Internal error',data:{codexErrorInfo:'usageLimitExceeded',token:'SYNTHETIC_TOKEN_NOT_REAL'}}});return;}
   if(turn.kind==='unconfirmed-active-abort'){record({kind:turn.kind,event:'transport-exit-without-result'});process.exit(0);}
   record({kind:turn.kind,event:'prompt-result',stopReason:'cancelled'});send({id:turn.id,result:{stopReason:'cancelled'}});
  }
 }
 else if(m.id!==undefined)send({id:m.id,error:{code:-32601,message:'Method not found'}});
});
`;

