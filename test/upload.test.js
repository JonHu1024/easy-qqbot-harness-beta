import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { QQClient } from '../src/qq.js';

test('分片大小为上限，末片短于block_size仍完整上传且保留原文件名',async()=>{
  const original=Buffer.from('0123456789'),received=[],finished=[];let preparedName;
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);
    res.setHeader('Content-Type','application/json');const json=value=>res.end(JSON.stringify(value));
    if(req.url==='/app/getAppAccessToken')return json({access_token:'token',expires_in:7200});
    if(req.url.endsWith('/upload_prepare')){preparedName=JSON.parse(bytes).file_name;return json({upload_id:'up',block_size:'8',parts:[{index:0,presigned_url:'https://upload.myqcloud.com/part0'},{index:1,presigned_url:'https://upload.myqcloud.com/part1'}]});}
    if(req.url.startsWith('/part')){received.push(bytes);return res.end();}
    if(req.url.endsWith('/upload_part_finish')){finished.push(JSON.parse(bytes));return json({});}
    if(req.url.endsWith('/files'))return json({file_info:'uploaded-data'});
    res.statusCode=404;json({});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const realFetch=globalThis.fetch,base=`http://127.0.0.1:${server.address().port}`;
  globalThis.fetch=(url,options)=>realFetch(base+new URL(url).pathname,options);
  try {
    const client=new QQClient({getConfig:()=>({qq:{appId:'1',appSecret:'s',sandbox:false}})});
    await client.upload({scene:'group',targetId:'g',fileType:4,fileData:original.toString('base64'),fileName:'original.txt'});
    assert.deepEqual(Buffer.concat(received),original);
    assert.equal(received[1].length,2);assert.equal(finished[1].block_size,'2');assert.equal(preparedName,'original.txt');
  } finally {globalThis.fetch=realFetch;await new Promise(r=>server.close(r));}
});

test('QQ 分片 index 从 1 开始也能上传，且按返回的 index 回传 part_index',async()=>{
  const original=Buffer.from('0123456789'),put=[],finish=[];
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await (const c of req)chunks.push(c);
    const raw=Buffer.concat(chunks);
    let body={};try{body=raw.length?JSON.parse(raw):{};}catch{body={};}
    res.setHeader('Content-Type','application/json');const json=value=>res.end(JSON.stringify(value));
    if(req.url==='/app/getAppAccessToken')return json({access_token:'token',expires_in:7200});
    if(req.url.endsWith('/upload_prepare'))return json({upload_id:'up',block_size:'6',parts:[
      {index:1,presigned_url:'https://upload.myqcloud.com/part1',block_size:'6'},
      {index:2,presigned_url:'https://upload.myqcloud.com/part2',block_size:'6'},
    ]});
    if(req.url.startsWith('/part')){put.push(req.url);return res.end();}
    if(req.url.endsWith('/upload_part_finish')){finish.push(body);return json({});}
    if(req.url.endsWith('/files'))return json({file_info:'ok-info'});
    res.statusCode=404;json({});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const realFetch=globalThis.fetch,base=`http://127.0.0.1:${server.address().port}`;
  globalThis.fetch=(url,options)=>realFetch(base+new URL(url).pathname,options);
  try {
    const client=new QQClient({getConfig:()=>({qq:{appId:'1',appSecret:'s',sandbox:false}})});
    const out=await client.upload({scene:'c2c',targetId:'u',fileType:1,fileData:original.toString('base64'),fileName:'a.png'});
    assert.equal(out.file_info,'ok-info');
    assert.deepEqual(put,['/part1','/part2']);
    assert.deepEqual(finish.map(f=>f.part_index),[1,2],'必须回传 QQ 给的原 index');
    assert.deepEqual(finish.map(f=>f.block_size),['6','4']);
  } finally { globalThis.fetch=realFetch; await new Promise(r=>server.close(r)); }
});

test('分片 index 重复或倒序时报错，空分片列表给出明确原因',async()=>{
  const cases=[
    {parts:[{index:2,presigned_url:'https://upload.myqcloud.com/a'},{index:2,presigned_url:'https://upload.myqcloud.com/b'}],match:/无效的上传分片信息/},
    {parts:[],match:/未返回任何上传分片/},
  ];
  for (const item of cases) {
    const server=http.createServer(async(req,res)=>{
      for await (const _ of req);
      res.setHeader('Content-Type','application/json');const json=v=>res.end(JSON.stringify(v));
      if(req.url==='/app/getAppAccessToken')return json({access_token:'t',expires_in:7200});
      if(req.url.endsWith('/upload_prepare'))return json({upload_id:'u',block_size:'6',parts:item.parts});
      json({});
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const realFetch=globalThis.fetch,base=`http://127.0.0.1:${server.address().port}`;
    globalThis.fetch=(url,options)=>realFetch(base+new URL(url).pathname,options);
    try {
      const client=new QQClient({getConfig:()=>({qq:{appId:'1',appSecret:'s',sandbox:false}})});
      await assert.rejects(()=>client.upload({scene:'c2c',targetId:'u',fileType:1,fileData:Buffer.from('0123456789').toString('base64')}),item.match);
    } finally { globalThis.fetch=realFetch; await new Promise(r=>server.close(r)); }
  }
});

