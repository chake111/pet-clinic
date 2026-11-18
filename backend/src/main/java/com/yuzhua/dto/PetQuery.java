package com.yuzhua.dto;

import lombok.Data;
import lombok.EqualsAndHashCode;

/**
 * 后台宠物档案筛选条件。keyword 同时命中宠物名称与主人昵称/手机号。
 */
@Data
@EqualsAndHashCode(callSuper = true)
public class PetQuery extends PageQuery {

    private String keyword;
}
