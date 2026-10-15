import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const nodes=new Map();
const document={
  getElementById(id){if(!nodes.has(id))nodes.set(id,{value:'',checked:!['frameOnly','mindMap','frameVert','maskName','maskGd','headUniform','hideDeptBar','roleColor','rawOrder'].includes(id),style:{},addEventListener(){},querySelectorAll(){return []}});return nodes.get(id);},
  querySelector(){return null},querySelectorAll(){return []},addEventListener(){}
};
document.getElementById('notes').value='';
document.getElementById('title').value='分层组织测试';
const context=vm.createContext({document,window:{},console,Set,Map,Date,Intl,location:{protocol:'https:',pathname:'/'}});
vm.runInContext(source,context);
const fixture=[
 ['供应','','','','','张三','副总经理','副总经理',''],
 ['供应','供应中心','计划部','','','李四','部门经理','部门经理',''],
 ['供应','供应中心','计划部','物控组','','王五','主管','主管',''],
 ['供应','供应中心','仓储物流部','','','赵六','部门经理','部门经理','吴江组'],
 ['供应','供应中心','仓储物流部','吴江组','吴江物流一组','钱七','主管','主管',''],
 ['供应','供应中心','仓储物流部','吴江组','吴江仓储一组','孙八','主管','主管',''],
 ['供应','供应中心','仓储物流部','漯河组','','周九','部门副经理','主管',''],
 ['供应','供应中心','仓储物流部','漯河组','漯河仓储一组','吴十','主管','主管',''],
 ['供应','供应中心','仓储物流部','漯河组','漯河仓储二组','郑一','仓储专员','基石员工',''],
 ['供应','规建中心','工程部','','','王二','部门副经理','部门副经理','吴江组'],
 ['供应','规建中心','工程部','吴江组','','冯佳','工程师','核心骨干',''],
];
const tsv=[['组织1','组织2','组织3','组织4','组织5','姓名','岗位','层级','兼管分组'],...fixture].map(r=>r.join('\t')).join('\n');
document.getElementById('data').value=tsv;
const result=vm.runInContext(`(()=>{const ps=parseRaw();const m=aggregate(ps);return {m,svg:buildSVG(m)}})()`,context);
const warehouse=result.m.depts.find(d=>d.name==='仓储物流部');
assert(warehouse,'adding a deeper branch must retain the warehouse department');
assert.equal(warehouse.cen,'供应中心');
assert.deepEqual(Array.from(warehouse.groups,g=>g.name).sort(),['吴江仓储一组','吴江物流一组','漯河仓储一组','漯河仓储二组'].sort());
const parents=warehouse.parentGroups;
assert.equal(parents?.length,2,'render regional groups between department and work teams');
assert.equal(parents.find(p=>p.name==='吴江组').ext?.姓名,'赵六');
assert.deepEqual(Array.from(parents.find(p=>p.name==='漯河组').heads,p=>p.姓名),['周九']);
assert.equal(result.m.depts.find(d=>d.name==='工程部').gmap['吴江组'].ext?.姓名,'王二','same-named engineering group must retain its own manager');
assert.equal(result.m.depts.find(d=>d.name==='计划部').gmap['物控组'].members[0].姓名,'王五','shallower branches must retain their work teams');
assert.equal(result.m.people.length,fixture.length,'regional leaders must not be duplicated');
assert.match(result.svg,/data-parent-group="吴江组"/);
assert.match(result.svg,/data-parent-group="漯河组"/);
assert.equal((result.svg.match(/data-name="周九"/g)||[]).length,1,'regional manager appears once');
for(const flag of ['frameOnly','frameVert','mindMap']){
  document.getElementById('frameOnly').checked=true;
  document.getElementById('frameVert').checked=flag==='frameVert';
  document.getElementById('mindMap').checked=flag==='mindMap';
  const svg=vm.runInContext('buildSVG(aggregate(parseRaw()))',context);
  assert.match(svg,/吴江组/);assert.match(svg,/漯河组/);assert.match(svg,/吴江物流一组/);
}
console.log('PASS: nested groups preserve regional reporting, shallow branches, same-name management and all chart modes');
