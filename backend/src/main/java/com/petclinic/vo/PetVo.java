package com.petclinic.vo;

import com.petclinic.entity.Pet;
import lombok.Data;
import lombok.EqualsAndHashCode;

/**
 * 后台宠物档案列表行：宠物信息 + 主人昵称/手机号。
 */
@Data
@EqualsAndHashCode(callSuper = true)
public class PetVo extends Pet {

    private String userNickname;
    private String userPhone;
}
