export interface McpActivity {id:string;sequence:number;createdAt:string;finishedAt?:string;durationMs?:number;method:string;name?:string;status:'running'|'succeeded'|'failed'|'interrupted';request:unknown;response?:unknown}
export interface McpActivityPage {records:McpActivity[];page:number;pages:number;total:number}
