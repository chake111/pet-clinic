package com.petclinic.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 公告 / 养宠科普。对应表 notice。正文直接存库（不学 MixPet 存 .txt 文件路径）。
 */
@Data
@TableName("notice")
public class Notice {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String title;
    private String cover;
    private String summary;
    private String content;

    /** 1 公告 2 活动 3 养宠科普 */
    private Integer type;
    private Integer topFlag;
    /** 0 草稿 1 已发布 2 下架 */
    private Integer status;
    private Integer viewCount;
    /** 首次发布时间；下架后重新发布不刷新 */
    private LocalDateTime publishTime;
    /** 首次发布人 admin_user.id；草稿为 null */
    private Long publishBy;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updateTime;

    @TableLogic
    @TableField(select = false)
    private Integer deleted;
}
