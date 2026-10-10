/**
 * What an old browser engine is missing, supplied before anything else runs.
 *
 * The build is compiled down to the syntax of the oldest engines the app
 * supports (see "browserslist" in package.json; a Hisense VIDAA 6 television
 * is Chromium 76). Compiling changes syntax, not the standard library: a call
 * to `Array.prototype.at` is still a call to something that is not there, and
 * one such call in a shared chunk stops the whole page. The methods below are
 * the ones the app and its libraries call that those engines lack.
 *
 * It also answers the one layout question CSS cannot ask for itself: whether
 * `gap` works in a flex container (Chromium 84). The answer goes on <html> as
 * data-flexgap="0", which the fallback rules written by
 * postcss/legacy-engines.cjs are keyed on.
 *
 * Returned as a string for an inline script in <head>, and written in ES5:
 * it has to parse on every engine, including ones older than those supported.
 */
export function engineFallbackScript(): string {
  return `(function(){try{
function at(n){n=Math.trunc(n)||0;if(n<0)n+=this.length;return n<0||n>=this.length?undefined:this[n]}
function def(o,k,v){if(o&&!o[k])Object.defineProperty(o,k,{value:v,writable:true,configurable:true})}
def(Array.prototype,"at",at);
def(String.prototype,"at",function(n){var c=at.call(this,n);return c===undefined?undefined:c});
if(typeof Int8Array!=="undefined")def(Object.getPrototypeOf(Int8Array.prototype),"at",at);
def(Object,"hasOwn",function(o,k){return Object.prototype.hasOwnProperty.call(Object(o),k)});
def(String.prototype,"replaceAll",function(s,r){
if(s instanceof RegExp)return this.replace(s,r);
return this.split(String(s)).join(typeof r==="function"?r(String(s)):String(r))});
def(Array.prototype,"findLast",function(f,t){for(var i=this.length-1;i>=0;i--)if(f.call(t,this[i],i,this))return this[i]});
def(Array.prototype,"findLastIndex",function(f,t){for(var i=this.length-1;i>=0;i--)if(f.call(t,this[i],i,this))return i;return -1});
if(typeof Element!=="undefined")def(Element.prototype,"replaceChildren",function(){
while(this.lastChild)this.removeChild(this.lastChild);
for(var i=0;i<arguments.length;i++){var c=arguments[i];this.appendChild(typeof c==="string"?document.createTextNode(c):c)}});
if(typeof crypto!=="undefined"&&crypto.getRandomValues)def(crypto,"randomUUID",function(){
var b=crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;
for(var h="",i=0;i<16;i++){h+=(b[i]+256).toString(16).slice(1);if(i===3||i===5||i===7||i===9)h+="-"}return h});
if(typeof Promise!=="undefined")def(Promise,"any",function(list){return new Promise(function(resolve,reject){
var left=0,errors=[];Array.prototype.forEach.call(list,function(p,i){left++;
Promise.resolve(p).then(resolve,function(e){errors[i]=e;if(--left===0)reject(errors[0])})});
if(left===0)reject(new Error("All promises were rejected"))})});
var d=document.documentElement,f=document.createElement("div");
f.style.cssText="display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden";
f.appendChild(document.createElement("div"));f.appendChild(document.createElement("div"));
d.appendChild(f);if(f.scrollHeight!==1)d.setAttribute("data-flexgap","0");d.removeChild(f);
}catch(e){}})()`;
}
