export function injectShim(html) {
  const src = String(html || "");
  const tag = '<script src="/mikcon-digest.js"></script>\n<script src="/mikcon-server-shim.js"></script>\n<script src="/payment-gateway.js"></script>\n<script src="/ops-desk.js"></script>';
  if (src.includes("mikcon-server-shim.js")) return src;
  if (/<\/head>/i.test(src)) return src.replace(/<\/head>/i, tag + "\n</head>");
  return tag + "\n" + src;
}

export const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MikconPC Server</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0b0f16;color:#e8eef7;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center}
  form{width:min(360px,92vw);background:#141a24;border:1px solid #2a3344;border-radius:14px;padding:24px}
  h1{font-size:18px;margin:0 0 6px}
  p{color:#9aa8bd;font-size:13px;line-height:1.45}
  label{display:block;font-size:12px;color:#9aa8bd;margin:10px 0 4px}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid #2a3344;background:#0b0f16;color:inherit}
  button{width:100%;padding:10px 12px;border:0;border-radius:10px;background:#1f5bb5;color:#fff;font-weight:700;margin-top:14px}
  #msg{min-height:18px;font-size:13px;margin-top:10px;color:#ef6a6a}
  .hide{display:none}
  #set-pw{margin-top:4px;border-top:1px solid #2a3344;padding-top:14px}
</style>
</head>
<body>
<form id="f">
  <h1>MikconPC Server</h1>
  <p>This PC is the controller. Sign in to open it in the browser.</p>
  <div id="sign-in">
    <label>Password</label>
    <input id="pw" type="password" autocomplete="current-password" placeholder="First boot is 1234" autofocus>
    <button type="submit" id="open-btn">Open</button>
  </div>
  <div id="set-pw" class="hide">
    <p>Set a new password for this controller. Confirm it, then save.</p>
    <label>New password</label>
    <input id="npw" type="password" autocomplete="new-password" placeholder="New password">
    <label>Confirm password</label>
    <input id="cpw" type="password" autocomplete="new-password" placeholder="Confirm password">
    <button type="submit" id="save-btn">Save password</button>
  </div>
  <div id="msg"></div>
</form>
<script>
(function(){
  var changing=false;
  var msg=document.getElementById("msg");
  function showChange(){
    changing=true;
    document.getElementById("sign-in").className="hide";
    document.getElementById("set-pw").className="";
    document.getElementById("npw").focus();
  }
  fetch("/api/session",{credentials:"same-origin"}).then(function(r){ return r.json(); }).then(function(j){
    if(j && j.ok && j.mustChange) showChange();
  }).catch(function(){});
  document.getElementById("f").addEventListener("submit", function(ev){
    ev.preventDefault();
    msg.textContent="";
    if(changing){
      fetch("/api/password",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:document.getElementById("npw").value,confirm:document.getElementById("cpw").value})})
        .then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||"Could not save"); location.href="/"; }); })
        .catch(function(e){ msg.textContent=e.message||"Could not save"; });
      return;
    }
    fetch("/api/login",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:document.getElementById("pw").value})})
      .then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||"Login failed"); if(j.mustChange){ showChange(); return; } location.href="/"; }); })
      .catch(function(e){ msg.textContent=e.message||"Login failed"; });
  });
})();
</script>
</body>
</html>
`;
