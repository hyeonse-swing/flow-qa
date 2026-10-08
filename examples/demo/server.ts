import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flow QA · Demo</title>
<style>body{font:17px system-ui;margin:60px auto;max-width:620px;padding:20px;color:#20302c;background:#f5f8f6}h1{font-size:32px}button,input{font:inherit;padding:10px;margin:4px;border:1px solid #bcc9c0;border-radius:6px}button{cursor:pointer;background:white}form{margin:30px 0}ul{padding:0}li{display:flex;align-items:center;justify-content:space-between;padding:12px;background:white;border-bottom:1px solid #ddd}#error{color:#b12525}</style>
<main><p>FLOW QA / LOCAL FIXTURE</p><h1>Simple task list</h1><p>Try adding a task, validating the title, and filtering the list in a real browser.</p>
<form id="form"><label for="title">Task title</label><input id="title" autocomplete="off"><button type="submit">Add</button></form>
<p id="error" role="alert" hidden></p><nav aria-label="Filters"><button id="all">All</button><button id="active">Active</button></nav><ul data-testid="task-list" id="list"></ul></main>
<script>
const tasks=[];let activeOnly=false;
const list=document.querySelector('#list');const error=document.querySelector('#error');
function render(){list.replaceChildren();tasks.filter(t=>!activeOnly||!t.done).forEach(t=>{const li=document.createElement('li');const text=document.createElement('span');text.textContent=t.title;li.append(text);if(!t.done){const button=document.createElement('button');button.textContent='Complete';button.onclick=()=>{t.done=true;render()};li.append(button)}list.append(li)})}
document.querySelector('#form').onsubmit=e=>{e.preventDefault();const input=document.querySelector('#title');const title=input.value.trim();if(!title){error.textContent='Enter a task title.';error.hidden=false;return}error.hidden=true;tasks.push({title,done:false});input.value='';render()};
document.querySelector('#all').onclick=()=>{activeOnly=false;render()};document.querySelector('#active').onclick=()=>{activeOnly=true;render()};
</script></html>`;

export async function startDemo(port = 4178) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(html);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listening address');
  return { server, url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const demo = await startDemo(Number(process.env.PORT ?? 4178));
  console.log(`Flow QA demo: ${demo.url}`);
  process.once('SIGINT', () => { void demo.close(); }); process.once('SIGTERM', () => { void demo.close(); });
}
