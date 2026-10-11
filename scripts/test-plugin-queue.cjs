const assert = require('node:assert/strict');
const { PluginConversationQueue } = require('../dist/main/extensions/conversationQueue');
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  let available=false;
  const calls=[];
  const failures=[];
  const queue=new PluginConversationQueue(()=>available,prompt=>{calls.push(prompt);available=false;},cause=>failures.push(cause));
  try {
    queue.enqueue({pluginId:'one',text:'first'});
    queue.enqueue({pluginId:'two',text:'second'});
    await delay(350);
    assert.equal(calls.length,0,'Active microphone/task must not be interrupted');
    available=true;await delay(300);
    assert.equal(calls[0].text,'first');
    await delay(300);assert.equal(calls.length,1,'Busy task must retain the next prompt');
    available=true;await delay(300);assert.equal(calls[1].text,'second');
    queue.enqueue({pluginId:'one',text:'cancelled'});queue.cancel('one');
    available=true;await delay(300);assert.equal(calls.length,2);
    for(let i=0;i<10;i++) queue.enqueue({pluginId:'one',text:String(i)});
    assert.throws(()=>queue.enqueue({pluginId:'one',text:'overflow'}),/队列已满/);
    queue.cancel();await delay(300);assert.equal(calls.length,2);
    queue.close();assert.throws(()=>queue.enqueue({pluginId:'one',text:'closed'}),/已关闭/);
    assert.deepEqual(failures,[]);
    console.log('PASS: FIFO, microphone/task priority, bounded queue, plugin cancellation, stop and close.');
  }finally{queue.close();}
})().catch(cause=>{console.error(cause);process.exitCode=1;});
