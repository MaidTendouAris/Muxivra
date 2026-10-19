export interface DownloadNetworkHop {url:string;status?:number;proxy?:string;addresses?:string[];lookupError?:string}
export interface DownloadNetworkRoute {hops:DownloadNetworkHop[];status?:number;error?:string}
export interface DownloadNetworkCheck {name:string;url:string;ok:boolean;elapsedMs:number;message:string;route?:DownloadNetworkRoute}
export interface DownloadNetworkReport {checkedAt:string;transport:string;checks:DownloadNetworkCheck[]}
