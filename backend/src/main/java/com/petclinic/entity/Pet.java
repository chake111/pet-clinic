package com.petclinic.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;

/**
 * 宠物档案。对应表 pet，归属于某个 sys_user。
 */
@Data
@TableName("pet")
public class Pet {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;
    private String name;

    /** 猫 / 狗 / 兔 / 仓鼠 / 龟 / 鸟 / 爬行 / 其他 */
    private String species;
    private String breed;

    /** 0 未知 1 公 2 母 */
    private Integer gender;
    private LocalDate birthday;
    private Integer ageMonth;
    private BigDecimal weight;
    private String color;

    private Integer isNeutered;
    /** 0 未接种 1 部分 2 已完成 */
    private Integer vaccineStatus;
    private Integer dewormFlag;

    private String avatar;
    private String allergy;
    private String medicalHistory;
    private String remark;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updateTime;

    @TableLogic
    @TableField(select = false)
    private Integer deleted;
}
