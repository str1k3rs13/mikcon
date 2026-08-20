// juanfi-app/www/reminder-store.js
// Per-router payment-reminder cache + banner validation. Cache/validation only:
// no RouterOS calls, no DOM behaviour. Loads as a plain <script> in index.html
// (exposes window.ReminderStore) and as a CommonJS module for the Node tests.
(function(root){
  "use strict";
  var DEFAULT_MESSAGE="Please settle your account on or before the due date to keep your internet connection active.";
  var MAX_MESSAGE=2000, MAX_BANNER=2*1024*1024;
  function cleanText(v){ return String(v==null?"":v).replace(/\r\n?/g,"\n"); }
  // Decodes a base64 payload to bytes in both the browser (atob) and Node
  // (Buffer). Malformed input degrades to an empty buffer rather than
  // throwing, so callers only need to check the resulting byte signature.
  function decodeBase64(b64){
    b64=String(b64||"");
    try{
      if(typeof atob==="function"){
        var bin=atob(b64),bytes=new Uint8Array(bin.length);
        for(var i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
        return bytes;
      }
      if(typeof Buffer!=="undefined"){
        var buf=Buffer.from(b64,"base64");
        return new Uint8Array(buf.buffer,buf.byteOffset,buf.byteLength);
      }
    }catch(e){ /* fall through to empty */ }
    return new Uint8Array(0);
  }
  function normalizeReminderConfig(v){
    v=v&&typeof v==="object"?v:{};
    var message=v.message==null?DEFAULT_MESSAGE:cleanText(v.message);
    if(message.length>MAX_MESSAGE) throw new Error("Reminder message must be 2,000 characters or fewer.");
    var contact=cleanText(v.contact).trim(),serviceUrl=cleanText(v.serviceUrl).trim();
    if(contact.length>160) throw new Error("Contact line must be 160 characters or fewer.");
    if(serviceUrl.length>500) throw new Error("Reminder URL must be 500 characters or fewer.");
    // Banner validation happens here too, not only in readBannerFile, because
    // this is the actual persistence boundary: anything that assembles a
    // banner object by hand (e.g. a future backup/restore path) and calls
    // store.write() must be held to the same "signature, never extension —
    // and never just a claimed mime string" rule as a live upload. A
    // caller-declared `mime` is not evidence of anything; only decoding the
    // payload and re-running the same detectReminderImage sniff proves it.
    var banner=null, b=v.banner;
    if(b){
      var mime=String(b.mime||"");
      var prefix="data:"+mime+";base64,";
      var dataUrl=String(b.dataUrl||"");
      if(/^(image\/png|image\/jpeg|image\/webp)$/.test(mime)&&dataUrl.indexOf(prefix)===0){
        var bytes=decodeBase64(dataUrl.slice(prefix.length));
        // The declared mime only survives if the decoded bytes actually
        // sniff to that same type, and the limit is enforced against the
        // real decoded length — a caller-supplied `size` is never trusted,
        // so `size` on the returned banner is always derived, never echoed.
        if(bytes.length<=MAX_BANNER&&detectReminderImage(bytes)===mime){
          banner={name:String(b.name||"banner"),mime:mime,size:bytes.length,dataUrl:dataUrl};
        }
      }
    }
    return {message:message,contact:contact,serviceUrl:serviceUrl,banner:banner};
  }
  function detectReminderImage(bytes){
    var b=bytes||[];
    if(b.length>=8&&b[0]===0x89&&b[1]===0x50&&b[2]===0x4e&&b[3]===0x47&&b[4]===0x0d&&b[5]===0x0a&&b[6]===0x1a&&b[7]===0x0a) return "image/png";
    if(b.length>=3&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff) return "image/jpeg";
    if(b.length>=12&&String.fromCharCode.apply(null,Array.prototype.slice.call(b,0,4))==="RIFF"&&String.fromCharCode.apply(null,Array.prototype.slice.call(b,8,12))==="WEBP") return "image/webp";
    return "";
  }
  function readBannerFile(file){
    if(!file||typeof file.arrayBuffer!=="function") return Promise.reject(new Error("Choose a banner image."));
    if(Number(file.size)>MAX_BANNER) return Promise.reject(new Error("Banner must be 2 MiB or smaller."));
    return file.arrayBuffer().then(function(buf){
      var bytes=new Uint8Array(buf), mime=detectReminderImage(bytes);
      if(!mime) throw new Error("Banner must be a PNG, JPEG, or WebP image.");
      return new Promise(function(resolve,reject){
        var fr=new FileReader();
        fr.onerror=function(){ reject(new Error("Could not read the banner image.")); };
        fr.onload=function(){ resolve({name:String(file.name||"banner"),mime:mime,size:Number(file.size)||bytes.length,dataUrl:String(fr.result||"")}); };
        fr.readAsDataURL(new Blob([bytes],{type:mime}));
      });
    });
  }
  function createReminderStore(adapter){
    function key(id){ id=String(id||"").trim(); if(!id) throw new Error("A router is required."); return "payment-reminder:"+id; }
    // Every method body runs inside Promise.resolve().then(...) so validation
    // errors (bad router id, oversized message, etc.) surface as a rejected
    // Promise rather than a synchronous throw. Callers (and assert.rejects)
    // depend on these always being real async rejections.
    return {
      read:function(id){ return Promise.resolve().then(function(){ return adapter.get(key(id)); }).then(function(v){ return normalizeReminderConfig(v); }); },
      write:function(id,v){ return Promise.resolve().then(function(){ var n=normalizeReminderConfig(v); return adapter.put(key(id),n).then(function(){ return n; }); }); },
      removeBanner:function(id){ return Promise.resolve().then(function(){ var k=key(id); return adapter.get(k).then(function(v){ v=normalizeReminderConfig(v); v.banner=null; return adapter.put(k,v).then(function(){ return v; }); }); }); }
    };
  }
  function indexedDbAdapter(idb){
    function db(){ return new Promise(function(resolve,reject){ var q=idb.open("mikcon-payment-reminder",1); q.onupgradeneeded=function(){ if(!q.result.objectStoreNames.contains("config")) q.result.createObjectStore("config"); }; q.onsuccess=function(){resolve(q.result);}; q.onerror=function(){reject(q.error||new Error("Could not open reminder storage."));}; }); }
    function tx(mode,fn){ return db().then(function(d){ return new Promise(function(resolve,reject){ var t=d.transaction("config",mode),s=t.objectStore("config"),q=fn(s); q.onsuccess=function(){resolve(q.result==null?null:q.result);}; q.onerror=function(){reject(q.error||new Error("Reminder storage failed."));}; t.oncomplete=function(){d.close();}; }); }); }
    return {get:function(k){return tx("readonly",function(s){return s.get(k);});},put:function(k,v){return tx("readwrite",function(s){return s.put(v,k);});},remove:function(k){return tx("readwrite",function(s){return s.delete(k);});}};
  }
  var api={createReminderStore:createReminderStore,normalizeReminderConfig:normalizeReminderConfig,detectReminderImage:detectReminderImage,readBannerFile:readBannerFile,DEFAULT_MESSAGE:DEFAULT_MESSAGE,MAX_MESSAGE:MAX_MESSAGE,MAX_BANNER:MAX_BANNER};
  if(typeof module!=="undefined"&&module.exports) module.exports=api;
  if(root&&root.indexedDB){ root.ReminderStore=createReminderStore(indexedDbAdapter(root.indexedDB)); root.ReminderStoreApi=api; }
})(typeof window!=="undefined"?window:null);
