package com.petclinic.vo;

import com.petclinic.entity.Pet;
import com.petclinic.entity.SysUser;
import lombok.Data;

import java.util.List;

/**
 * 后台用户详情：账号信息 + 关联的宠物档案与最近预约记录，
 * 一个请求带回，省得后台为放一个抽屉发三次请求。
 */
@Data
public class UserDetailVo {

    private SysUser user;
    private List<Pet> pets;
    private List<AppointmentVo> appointments;
}
