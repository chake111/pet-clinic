import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync('frontend/src/api/http.js','utf8').replace(/^import .*$/gm,'').replace(/export const /g,'const ').replace('export default http;','').replace('export default http','');
for(const [url,kind,expected] of [['/common/upload','admin','admin'],['/common/upload','client','client'],['/admin/record',undefined,'admin']]){
 let response;const cleared=[];const redirects=[];
 const http={interceptors:{request:{use(){}},response:{use(fn){response=fn}}}};
 vm.runInNewContext(source,{axios:{create:()=>http},ElMessage:{error(){}},clearToken:k=>cleared.push(k),getToken:()=>null,location:{pathname:'/admin/workbench/235',search:'',replace:u=>redirects.push(u)},FormData});
 await assert.rejects(response({data:{code:401,msg:'登录已过期'},config:{url,kind}}));
 assert.equal(cleared[0],expected);
 assert.ok(redirects[0].startsWith(expected==='admin'?'/admin/login?':'/login?'));
}
console.log('PASS upload expired login: explicit admin/client identity and admin URL fallback');
