import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const headers=['中心','部门','分组','姓名','岗位','层级','兼管分组'];
const fixture=[
 ['总机构','','','张三','副总经理','副总经理','中心甲、中心乙'],
 ['中心甲','部门甲','','李四','部门经理','部门经理',''],
 ['中心甲','部门甲','工作甲组','王五','主管','主管',''],
 ['中心乙','部门乙','','赵六','部门经理','部门经理',''],
 ['中心乙','部门乙','工作乙组','钱七','主管','主管',''],
];
function render(rows,flags=[]){
 const nodes=new Map();
 const document={getElementById(id){if(!nodes.has(id))nodes.set(id,{value:'',checked:!['frameOnly','mindMap','frameVert','maskName','maskGd','headUniform','hideDeptBar','roleColor','rawOrder'].includes(id),style:{},addEventListener(){},querySelectorAll(){return []}});return nodes.get(id);},querySelector(){return null},querySelectorAll(){return []},addEventListener(){}};
 document.getElementById('data').value=[headers,...rows].map(r=>r.join('\t')).join('\n');
 document.getElementById('title').value='兼管测试';
 for(const flag of flags)document.getElementById(flag).checked=true;
 const context=vm.createContext({document,window:{},console,Set,Map,Date,Intl,location:{protocol:'https:',pathname:'/'}});
 vm.runInContext(source,context);
 return vm.runInContext(`(()=>{const m=aggregate(parseRaw());return {m,svg:buildSVG(m),centers:window._cenExt,depts:window._deptExt,hints:window._structFixes}})()`,context);
}
for(const separator of ['、','，',',','；',';']){
 const rows=fixture.map(r=>[...r]);rows[0][6]=` 中心甲 ${separator} 中心乙 ${separator} 中心甲 `;
 const r=render(rows);
 assert.equal(r.centers['中心甲']?.姓名,'张三','first explicitly listed center must retain its interim manager');
 assert.equal(r.centers['中心乙']?.姓名,'张三','second explicitly listed center must retain its interim manager');
 assert.equal((r.svg.match(/张三 兼管/g)||[]).length,2,'both center bars must display the manager');
 assert.equal(r.m.people.length,fixture.length,'interim labels must not duplicate personnel or headcount');
 assert.equal(r.m.TOPS[0].姓名,'张三','the primary leadership position must be retained');
 assert(!r.hints.some(h=>h.includes('表里没有叫这个名字')));
}
const masked=render(fixture,['maskName']);
assert.equal((masked.svg.match(/张X 兼管/g)||[]).length,2);
assert(!masked.svg.includes('张三'),'masking must also apply to repeated interim labels');
for(const flags of [['frameOnly']]){
 const r=render(fixture,flags);
 assert.equal((r.svg.match(/张三 兼管/g)||[]).length,2,'each skeleton center must retain its interim annotation');
}
const assigned=render([...fixture,['中心甲','','','孙八','中心总监','中心总监','']]);
assert.equal(assigned.centers['中心甲'],undefined,'a formal leader must take precedence for its own center');
assert.equal(assigned.centers['中心乙']?.姓名,'张三','a formal leader in one center must not suppress another interim assignment');
const ambiguousRows=fixture.map(r=>[...r]);
ambiguousRows[1][0]=ambiguousRows[2][0]='公司甲·中心甲';
ambiguousRows.push(['公司乙·中心甲','部门丙','工作丙组','周九','主管','主管','']);
const ambiguous=render(ambiguousRows);
assert.equal(ambiguous.centers['公司甲·中心甲'],undefined);
assert.equal(ambiguous.centers['公司乙·中心甲'],undefined);
assert.equal(ambiguous.centers['中心乙']?.姓名,'张三','an ambiguous name must not suppress independent valid assignments');
assert(ambiguous.hints.some(h=>h.includes('同名')&&h.includes('完整')));
ambiguousRows[0][6]='公司甲·中心甲、中心乙';
const exact=render(ambiguousRows);
assert.equal(exact.centers['公司甲·中心甲']?.姓名,'张三');
assert.equal(exact.centers['公司乙·中心甲'],undefined);
const mixedRows=fixture.map(r=>[...r]);mixedRows[0][6]='中心甲、部门乙、工作乙组';
const mixed=render(mixedRows);
assert.equal(mixed.centers['中心甲']?.姓名,'张三');
assert.equal(mixed.depts['部门乙']?.姓名,'张三');
assert.equal(mixed.m.depts.find(d=>d.name==='部门乙').gmap['工作乙组'].ext?.姓名,'张三','mixed unit types must be resolved independently');
console.log('PASS: multiple interim units resolve separately, retain all labels and counts, and respect masking, ambiguity and formal leaders');
