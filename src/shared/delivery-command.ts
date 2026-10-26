// A display/edit format with JSON-quoted tokens. No shell is involved in execution.
export function formatCommand(executable:string,args:string[]):string {
  return [executable,...args].map(value=>JSON.stringify(value)).join(' ')
}
export function parseCommand(command:string):string[] {
  if(command.length>100000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(command))throw new Error('命令过长或包含控制字符')
  const tokens:string[]=[];let i=0
  while(i<command.length){
    if(/\s/.test(command[i])){i++;continue}
    if(command[i]==='"'){
      const start=i++;let escaped=false,closed=false
      while(i<command.length){const ch=command[i++];if(ch==='"'&&!escaped){closed=true;break}escaped=ch==='\\'&&!escaped}
      if(!closed)throw new Error('命令引号未闭合')
      try{tokens.push(JSON.parse(command.slice(start,i)))}catch{throw new Error('命令中的双引号参数需要使用 JSON 转义')}
      if(i<command.length&&!/\s/.test(command[i]))throw new Error('命令参数之间需要空格')
    }else{const start=i;while(i<command.length&&!/\s/.test(command[i]))i++;const token=command.slice(start,i);if(/["'`;&|<>]/.test(token))throw new Error('含特殊字符的参数请使用双引号和 JSON 转义');tokens.push(token)}
  }
  if(!tokens.length)throw new Error('请输入 FFmpeg 命令')
  return tokens
}
