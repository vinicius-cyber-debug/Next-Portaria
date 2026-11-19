import {stdin as input,stdout as output} from 'node:process';
/** Never sends secret input to stdout, process arguments or an external logger. */
export function terminalSecret(prompt){
 if(!input.isTTY||!input.setRawMode)throw Error('Execute em um terminal interativo.');
 output.write(prompt);
 return new Promise((resolve,reject)=>{
  let value='';const previous=input.isRaw;input.setRawMode(true);input.resume();
  function finish(error){input.removeListener('data',key);input.setRawMode(previous);input.pause();output.write('\n');if(error)reject(error);else resolve(value);}
  function key(chunk){for(const character of String(chunk)){
   if(character==='\u0003'){finish(Error('Operação cancelada.'));return;}
   if(character==='\r'||character==='\n'){finish();return;}
   if(character==='\u007f'||character==='\b'){if(value.length){value=value.slice(0,-1);output.write('\b \b');}continue;}
   if(character>=' '&&value.length<512){value+=character;output.write('*');}
  }}
  input.on('data',key);
 });
}
