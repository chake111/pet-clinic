package com.yuzhua.dto;

import lombok.Data;

/**
 * 公告新增 / 编辑的请求体。
 *
 * 只放编辑内容与展示配置；阅读量、发布人、发布时间与系统时间由服务端维护。
 */
@Data
public class NoticeForm {

    private String title;
    private String cover;
    private String summary;
    private String content;

    /** 1 公告 2 活动 3 养宠科普 */
    private Integer type;

    /** 0 否 1 是 */
    private Integer topFlag;

    /** 0 草稿 1 已发布 2 已下架；新增不传按草稿，编辑不传保持原值 */
    private Integer status;
}
