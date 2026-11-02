import {WebSocketServer,WebSocket} from 'ws';

export function attachCollectorStream(server,{authorize,ingest,enabled=true}) {
  const stats={protocol:'collector-ws-v1',connections:0,batches:0,failures:0,lastAckAt:null};
  const sockets=new WebSocketServer({noServer:true,maxPayload:2*1024*1024,perMessageDeflate:false});
  server.on('upgrade',(request,socket,head)=>{
    if(new URL(request.url,'http://localhost').pathname!=='/api/collector/stream'){
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');return;
    }
    if(!enabled||!authorize(request)){
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return;
    }
    sockets.handleUpgrade(request,socket,head,ws=>sockets.emit('connection',ws));
  });
  sockets.on('connection',socket=>{
    stats.connections++;let busy=false,alive=true;
    socket.on('pong',()=>{alive=true;});
    const timer=setInterval(()=>{if(!alive)return socket.terminate();alive=false;socket.ping();},30000);timer.unref?.();
    socket.on('message',async(bytes,binary)=>{
      if(busy||binary){socket.close(1008,'One batch at a time');return;}
      busy=true;
      try{
        const body=JSON.parse(bytes.toString());
        if(!/^[\w:.-]{1,100}$/.test(body.batchId||''))throw Error('Invalid batch ID');
        if(!Array.isArray(body.events)||body.events.length>250)throw Error('Invalid batch size');
        const result=await ingest(body);
        stats.batches++;stats.lastAckAt=Date.now();
        if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({protocol:stats.protocol,batchId:body.batchId,...result}));
      }catch(error){
        stats.failures++;
        if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({durable:false,error:'Batch not committed'}));
      }finally{busy=false;}
    });
    socket.on('error',()=>{stats.failures++;});
    socket.on('close',()=>{clearInterval(timer);stats.connections--;});
  });
  return {status:()=>({...stats}),close:()=>{for(const socket of sockets.clients)socket.close(1012,'Service restart');sockets.close();}};
}
