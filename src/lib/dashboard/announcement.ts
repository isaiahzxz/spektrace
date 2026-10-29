import { z } from "zod";
export const announcementSchema=z.object({published:z.boolean(),title:z.string().trim().max(80),body:z.string().trim().max(600),kind:z.enum(['update','issue','maintenance'])}).strict().refine(v=>!v.published||(v.title.length>0&&v.body.length>0),{message:'Add a title and message before publishing.'});
export type Announcement=z.infer<typeof announcementSchema>;
export const emptyAnnouncement:Announcement={published:false,title:'',body:'',kind:'update'};

export function publicAnnouncement(value:Announcement):Announcement{return value.published?value:emptyAnnouncement;}
